import {
  buildAccountId,
  readStoredAntigravityAccounts,
  upsertStoredAntigravityAccount,
} from "./account-store.ts";
import { PROVIDER_ID, REQUEST_ENDPOINTS } from "./constants.ts";
import { formatRefreshParts, isOAuthAuth, needsRefresh, parseRefreshParts } from "./auth-state.ts";
import {
  clearRefreshInFlight,
  getCurrentRefreshToken,
  refreshTokensSafe,
  setCurrentRefreshToken,
} from "./credentials.ts";
import { refreshGeminiCliTokens } from "./gemini-cli.ts";
import { fetchWithRetry } from "./http.ts";
import { log } from "./logger.ts";
import { resolveAntigravityModel } from "./models.ts";
import { ensureProjectContext } from "./project.ts";
import {
  buildAntigravityRequest,
  createResponseUnwrapStream,
  isGenerativeLanguageRequest,
  unwrapAntigravityJson,
} from "./transforms.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientApi = any;

type OAuthInput = {
  type: string;
  refresh?: string;
  access?: string;
  expires?: number;
  email?: string;
  kind?: "antigravity" | "gemini-cli";
};

type ReadyAuth = {
  access: string;
  refresh: string;
  expires: number;
  projectId: string;
  email?: string;
  kind: "antigravity" | "gemini-cli";
};

function resolveRequestModelID(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  const hintedModel = headers.get("x-antigravity-model-id");
  if (hintedModel) {
    return hintedModel;
  }

  const url = input instanceof Request ? input.url : input.toString();
  const match = url.match(/\/models\/([^:]+):/);
  return match?.[1];
}

const accountCooldowns = new Map<string, number>();

function getAccountKey(
  refresh: string,
  email?: string,
  kind: "antigravity" | "gemini-cli" = "antigravity",
): string {
  return buildAccountId(refresh, email, kind);
}

function isCoolingDown(
  refresh: string,
  email?: string,
  kind: "antigravity" | "gemini-cli" = "antigravity",
): boolean {
  const until = accountCooldowns.get(getAccountKey(refresh, email, kind));
  return typeof until === "number" && until > Date.now();
}

function shouldRotateOnResponse(response: Response, bodyText: string): boolean {
  if (response.status === 401) {
    return /invalid authentication credentials|unauthenticated|unauthorized|login cookie/i.test(
      bodyText,
    );
  }

  if (response.status === 429) {
    return /RATE_LIMIT_EXCEEDED|quota will reset|exhausted your capacity|RESOURCE_EXHAUSTED/i.test(
      bodyText,
    );
  }

  if (response.status === 403) {
    return /The caller does not have permission|PERMISSION_DENIED|caller does not have permission/i.test(
      bodyText,
    );
  }

  return false;
}

function shouldRotateCandidateOnError(candidate: OAuthInput, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  if ((candidate.kind ?? "antigravity") === "gemini-cli") {
    if (/could not resolve a usable Code Assist project/i.test(message)) {
      return true;
    }
  }

  return /token refresh failed|invalid_grant|invalid authentication credentials|401|403  — forbidden/i.test(
    message,
  );
}

function markAccountCooldown(
  refresh: string,
  response: Response,
  bodyText: string,
  email?: string,
  kind: "antigravity" | "gemini-cli" = "antigravity",
): void {
  const retryAfterSeconds = Number(response.headers.get("retry-after") || "0");
  const retryAfterMsHeader = Number(response.headers.get("retry-after-ms") || "0");
  const bodyRetryDelay = bodyText.match(/"retryDelay":\s*"([\d.]+)s"/);
  const bodyRetryMs = bodyRetryDelay?.[1] ? Math.ceil(Number(bodyRetryDelay[1]) * 1000) : 0;
  const cooldownMs =
    retryAfterMsHeader || Math.ceil(retryAfterSeconds * 1000) || bodyRetryMs || 30_000;
  accountCooldowns.set(
    getAccountKey(refresh, email, kind),
    Date.now() + Math.max(cooldownMs, 1_000),
  );
}

async function buildAuthCandidates(
  primary: OAuthInput,
  readAccounts: typeof readStoredAntigravityAccounts,
  requestedModelID?: string,
): Promise<OAuthInput[]> {
  const candidates: OAuthInput[] = [];
  const seen = new Set<string>();
  const resolvedModel = requestedModelID ? resolveAntigravityModel(requestedModelID) : undefined;
  const allowedKinds = resolvedModel?.isClaude ? ["antigravity"] : ["gemini-cli", "antigravity"];

  if (
    isOAuthAuth(primary) &&
    !isCoolingDown(primary.refresh, primary.email, primary.kind ?? "antigravity") &&
    allowedKinds.includes(primary.kind ?? "antigravity")
  ) {
    candidates.push(primary);
    seen.add(getAccountKey(primary.refresh, primary.email, primary.kind ?? "antigravity"));
  }

  for (const account of await readAccounts()) {
    const accountKey = getAccountKey(account.refresh, account.email, account.kind);
    if (
      seen.has(accountKey) ||
      isCoolingDown(account.refresh, account.email, account.kind) ||
      !allowedKinds.includes(account.kind)
    ) {
      continue;
    }
    candidates.push({
      type: "oauth",
      refresh: account.refresh,
      access: account.access,
      expires: account.expires,
      email: account.email,
      kind: account.kind,
    });
    seen.add(accountKey);
  }

  return candidates.sort((left, right) => {
    const leftKind = left.kind ?? "antigravity";
    const rightKind = right.kind ?? "antigravity";
    return allowedKinds.indexOf(leftKind) - allowedKinds.indexOf(rightKind);
  });
}

async function persistAuth(client: ClientApi, auth: ReadyAuth): Promise<void> {
  await client.auth.set({
    path: { id: PROVIDER_ID },
    body: {
      type: "oauth",
      access: auth.access,
      refresh: auth.refresh,
      expires: auth.expires,
      ...(auth.email ? { email: auth.email } : {}),
      kind: auth.kind,
    },
  });
}

async function prepareAuthState(
  auth: OAuthInput,
  client: ClientApi,
  configuredProjectId?: string,
  requestedModelID?: string,
): Promise<ReadyAuth> {
  if (!isOAuthAuth(auth)) {
    throw new Error("OAuth auth state is required for Antigravity requests");
  }

  const existingParts = parseRefreshParts(auth.refresh);
  if (existingParts.refreshToken && existingParts.refreshToken !== getCurrentRefreshToken()) {
    clearRefreshInFlight();
    setCurrentRefreshToken(existingParts.refreshToken);
  }

  let nextAuth = auth;
  const authKind = auth.kind ?? "antigravity";
  if (needsRefresh(nextAuth)) {
    const refreshed =
      authKind === "gemini-cli"
        ? await refreshGeminiCliTokens(existingParts.refreshToken)
        : await refreshTokensSafe(existingParts.refreshToken);
    nextAuth = {
      type: "oauth",
      access: refreshed.access,
      expires: refreshed.expires,
      refresh: formatRefreshParts({
        refreshToken: refreshed.refresh,
        projectId: existingParts.projectId,
        managedProjectId: existingParts.managedProjectId,
      }),
      email: auth.email,
      kind: authKind,
    };
  }

  const resolvedModel = requestedModelID ? resolveAntigravityModel(requestedModelID) : undefined;
  const userAgentModel =
    authKind === "gemini-cli"
      ? (resolvedModel?.cliModel ?? resolvedModel?.actualModel ?? requestedModelID)
      : undefined;

  const projectContext = await ensureProjectContext(
    nextAuth,
    authKind,
    configuredProjectId,
    userAgentModel,
  );
  const refreshParts = parseRefreshParts(projectContext.auth.refresh);
  setCurrentRefreshToken(refreshParts.refreshToken);

  const ready: ReadyAuth = {
    access: projectContext.auth.access || "",
    expires: projectContext.auth.expires || 0,
    refresh: projectContext.auth.refresh,
    projectId: projectContext.projectId,
    email: auth.email,
    kind: authKind,
  };

  if (
    ready.refresh !== auth.refresh ||
    ready.access !== auth.access ||
    ready.expires !== auth.expires ||
    ready.email !== auth.email
  ) {
    await persistAuth(client, ready);
  }

  await upsertStoredAntigravityAccount({
    access: ready.access,
    refresh: ready.refresh,
    expires: ready.expires,
    email: ready.email,
    kind: ready.kind,
  });

  return ready;
}

async function transformResponse(response: Response, streaming: boolean): Promise<Response> {
  const contentType = response.headers.get("content-type") || "";
  if (streaming && response.body && contentType.includes("text/event-stream")) {
    const stream = createResponseUnwrapStream(response.body.getReader());
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  if (!contentType.includes("application/json")) {
    return response;
  }

  const text = await response.text();
  return new Response(unwrapAntigravityJson(text), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createCustomFetch(
  getAuth: () => Promise<OAuthInput>,
  client: ClientApi,
  readAccounts: typeof readStoredAntigravityAccounts = readStoredAntigravityAccounts,
  getConfiguredProjectId: () => Promise<string | undefined> = async () => undefined,
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const auth = await getAuth();
    if (!isOAuthAuth(auth) || !isGenerativeLanguageRequest(input)) return fetch(input, init);

    const requestedModelID = resolveRequestModelID(input, init);
    const configuredProjectId = await getConfiguredProjectId();
    const candidates = await buildAuthCandidates(auth, readAccounts, requestedModelID);
    let lastResponse: Response | null = null;
    let lastCandidateError: unknown = null;

    candidateLoop: for (const candidate of candidates) {
      let candidateAuth = candidate;

      for (let refreshAttempt = 0; refreshAttempt < 2; refreshAttempt += 1) {
        let readyAuth: ReadyAuth;
        try {
          readyAuth = await prepareAuthState(
            candidateAuth,
            client,
            configuredProjectId,
            requestedModelID,
          );
        } catch (error) {
          log.warn("Failed to prepare auth state", {
            kind: candidate.kind ?? "antigravity",
            error: String(error),
          });
          if (shouldRotateCandidateOnError(candidate, error)) {
            lastCandidateError = error;
            continue candidateLoop;
          }
          throw error;
        }

        const endpoints =
          readyAuth.kind === "gemini-cli" ? [REQUEST_ENDPOINTS[0]] : REQUEST_ENDPOINTS;

        for (const endpoint of endpoints) {
          try {
            const prepared = await buildAntigravityRequest(
              input,
              init,
              readyAuth.access,
              readyAuth.projectId,
              endpoint,
              readyAuth.kind,
            );
            const response = await fetchWithRetry(prepared.request, prepared.init, 3);
            lastResponse = response;

            if (response.status === 401) {
              const bodyText = await response
                .clone()
                .text()
                .catch(() => "");
              if (refreshAttempt === 0) {
                candidateAuth = { ...candidateAuth, access: undefined, expires: undefined };
                continue;
              }
              if (shouldRotateOnResponse(response, bodyText)) {
                lastResponse = response;
                continue candidateLoop;
              }
            }

            if (response.status === 429) {
              const bodyText = await response
                .clone()
                .text()
                .catch(() => "");
              if (shouldRotateOnResponse(response, bodyText)) {
                markAccountCooldown(
                  readyAuth.refresh,
                  response,
                  bodyText,
                  readyAuth.email,
                  readyAuth.kind,
                );
                continue candidateLoop;
              }
            }

            if (response.status === 403) {
              const bodyText = await response
                .clone()
                .text()
                .catch(() => "");
              if (shouldRotateOnResponse(response, bodyText)) {
                continue candidateLoop;
              }
            }

            if (response.status >= 500 || response.status === 404) {
              continue;
            }

            return transformResponse(response, prepared.streaming);
          } catch (error) {
            log.warn("Antigravity request endpoint failed", { endpoint, error: String(error) });
          }
        }

        break;
      }
    }

    if (lastResponse) {
      return transformResponse(
        lastResponse,
        lastResponse.headers.get("content-type")?.includes("text/event-stream") || false,
      );
    }

    if (lastCandidateError instanceof Error) {
      throw lastCandidateError;
    }

    if (lastCandidateError) {
      throw new Error(String(lastCandidateError));
    }

    return new Response(JSON.stringify({ error: "antigravity_request_failed" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  };
}

export const __testExports = {
  getAccountKey,
  shouldRotateCandidateOnError,
  shouldRotateOnResponse,
};
