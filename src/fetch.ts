import {
  buildAccountId,
  readStoredAntigravityAccounts,
  upsertStoredAntigravityAccount,
} from "./account-store.ts";
import { PROVIDER_ID, REQUEST_ENDPOINTS } from "./constants.ts";
import { formatRefreshParts, isOAuthAuth, needsRefresh, parseRefreshParts } from "./auth-state.ts";
import {
  APP_STATE_REFRESH_TOKEN,
  clearRefreshInFlight,
  getCurrentRefreshToken,
  importInstalledAntigravityCredentials,
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

function getAccountKey(refresh: string, email?: string): string {
  return buildAccountId(refresh, email);
}

function isCoolingDown(refresh: string, email?: string): boolean {
  const until = accountCooldowns.get(getAccountKey(refresh, email));
  return typeof until === "number" && until > Date.now();
}

function shouldRotateOnResponse(response: Response, bodyText: string): boolean {
  if (response.status !== 429) return false;
  return /RATE_LIMIT_EXCEEDED|quota will reset|exhausted your capacity|RESOURCE_EXHAUSTED/i.test(
    bodyText,
  );
}

function markAccountCooldown(
  refresh: string,
  response: Response,
  bodyText: string,
  email?: string,
): void {
  const retryAfterSeconds = Number(response.headers.get("retry-after") || "0");
  const retryAfterMsHeader = Number(response.headers.get("retry-after-ms") || "0");
  const bodyRetryDelay = bodyText.match(/"retryDelay":\s*"([\d.]+)s"/);
  const bodyRetryMs = bodyRetryDelay?.[1] ? Math.ceil(Number(bodyRetryDelay[1]) * 1000) : 0;
  const cooldownMs =
    retryAfterMsHeader || Math.ceil(retryAfterSeconds * 1000) || bodyRetryMs || 30_000;
  accountCooldowns.set(getAccountKey(refresh, email), Date.now() + Math.max(cooldownMs, 1_000));
}

async function buildAuthCandidates(
  primary: OAuthInput,
  requestedModelID?: string,
): Promise<OAuthInput[]> {
  const candidates: OAuthInput[] = [];
  const seen = new Set<string>();
  const resolvedModel = requestedModelID ? resolveAntigravityModel(requestedModelID) : undefined;
  const allowedKinds = resolvedModel?.isClaude ? ["antigravity"] : ["gemini-cli", "antigravity"];

  if (
    isOAuthAuth(primary) &&
    !isCoolingDown(primary.refresh, primary.email) &&
    allowedKinds.includes(primary.kind ?? "antigravity")
  ) {
    candidates.push(primary);
    seen.add(getAccountKey(primary.refresh, primary.email));
  }

  for (const account of await readStoredAntigravityAccounts()) {
    const accountKey = getAccountKey(account.refresh, account.email);
    if (
      seen.has(accountKey) ||
      isCoolingDown(account.refresh, account.email) ||
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

async function prepareAuthState(auth: OAuthInput, client: ClientApi): Promise<ReadyAuth> {
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
  if (authKind === "antigravity" && existingParts.refreshToken === APP_STATE_REFRESH_TOKEN) {
    const imported = await importInstalledAntigravityCredentials();
    if (!imported) {
      throw new Error("No reusable Antigravity desktop session was found");
    }
    nextAuth = {
      type: "oauth",
      access: imported.access,
      expires: imported.expires,
      refresh: formatRefreshParts({
        refreshToken: imported.refresh,
        projectId: existingParts.projectId,
        managedProjectId: existingParts.managedProjectId,
      }),
      email: auth.email,
      kind: authKind,
    };
  } else if (needsRefresh(nextAuth)) {
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

  const projectContext = await ensureProjectContext(nextAuth, authKind);
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

export function createCustomFetch(getAuth: () => Promise<OAuthInput>, client: ClientApi) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const auth = await getAuth();
    if (!isOAuthAuth(auth) || !isGenerativeLanguageRequest(input)) return fetch(input, init);

    const requestedModelID = resolveRequestModelID(input, init);
    const candidates = await buildAuthCandidates(auth, requestedModelID);
    let lastResponse: Response | null = null;

    candidateLoop: for (const candidate of candidates) {
      let candidateAuth = candidate;

      for (let refreshAttempt = 0; refreshAttempt < 2; refreshAttempt += 1) {
        const readyAuth = await prepareAuthState(candidateAuth, client);

        for (const endpoint of REQUEST_ENDPOINTS) {
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

            if (response.status === 401 && refreshAttempt === 0) {
              candidateAuth = { ...candidateAuth, access: undefined, expires: undefined };
              continue;
            }

            if (response.status === 429) {
              const bodyText = await response
                .clone()
                .text()
                .catch(() => "");
              if (shouldRotateOnResponse(response, bodyText)) {
                markAccountCooldown(readyAuth.refresh, response, bodyText, readyAuth.email);
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

    return new Response(JSON.stringify({ error: "antigravity_request_failed" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  };
}

export const __testExports = {
  getAccountKey,
};
