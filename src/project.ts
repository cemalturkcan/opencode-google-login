import {
  CODE_ASSIST_HEADERS,
  DEFAULT_PROJECT_ID,
  PROVIDER_ID,
  PROJECT_CLIENT_METADATA_HEADER,
  PROJECT_ENDPOINTS,
  REQUEST_ENDPOINTS,
  getAntigravityHeaders,
} from "./constants.ts";
import { formatRefreshParts, parseRefreshParts, type OAuthAuthState } from "./auth-state.ts";
import { buildGeminiCliUserAgent, createGeminiCliActivityRequestId } from "./gemini-cli.ts";
import { log } from "./logger.ts";

type LoadPayload = {
  cloudaicompanionProject?: string | { id?: string };
  currentTier?: { id?: string };
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
  ineligibleTiers?: Array<{
    reasonCode?: string;
    reasonMessage?: string;
    validationUrl?: string;
    validationLearnMoreUrl?: string;
  }>;
};

type ConfigLike = {
  provider?: Record<string, { options?: Record<string, unknown> }>;
};

type ProviderLike = {
  options?: Record<string, unknown>;
};

type PluginClientLike = {
  config?: {
    get?: (...args: any[]) => Promise<any>;
  };
};

type ProjectResolution = {
  effectiveProjectId: string;
  managedProjectId?: string;
};

const metadataPlatform = "PLATFORM_UNSPECIFIED";
type AuthMode = "antigravity" | "gemini-cli";

export class ProjectIdRequiredError extends Error {
  constructor() {
    super("Google (Gemini CLI) could not resolve a usable Code Assist project for this account.");
    this.name = "ProjectIdRequiredError";
  }
}

export class AccountValidationRequiredError extends Error {
  constructor(
    message: string,
    public readonly validationUrl?: string,
  ) {
    super(validationUrl ? `${message} ${validationUrl}`.trim() : message);
    this.name = "AccountValidationRequiredError";
  }
}

function isFreeTier(tierId: string | undefined): boolean {
  return tierId === "FREE" || tierId === "free-tier";
}

function normalizeProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

export function resolveConfiguredProjectId(
  input: {
    provider?: ProviderLike | null;
    config?: ConfigLike | null;
    configProjectId?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string | undefined {
  const env = input.env ?? process.env;

  return (
    normalizeProjectId(env.OPENCODE_GEMINI_PROJECT_ID) ??
    normalizeProjectId(input.provider?.options?.projectId) ??
    normalizeProjectId(input.configProjectId) ??
    normalizeProjectId(input.config?.provider?.[PROVIDER_ID]?.options?.projectId) ??
    normalizeProjectId(input.config?.provider?.antigravity?.options?.projectId) ??
    normalizeProjectId(env.GOOGLE_CLOUD_PROJECT) ??
    normalizeProjectId(env.GOOGLE_CLOUD_PROJECT_ID)
  );
}

export async function resolveConfiguredProjectIdFromClient(
  client: PluginClientLike | null | undefined,
): Promise<string | undefined> {
  if (!client?.config?.get) {
    return undefined;
  }

  try {
    const result = await client.config.get();
    return resolveConfiguredProjectId({ config: result?.data as ConfigLike | undefined });
  } catch {
    return undefined;
  }
}

function buildMetadata(projectId?: string, mode: AuthMode = "antigravity"): Record<string, string> {
  const metadata: Record<string, string> = {
    ideType: mode === "gemini-cli" ? "IDE_UNSPECIFIED" : "ANTIGRAVITY",
    platform: metadataPlatform,
    pluginType: "GEMINI",
  };
  if (projectId) metadata.duetProject = projectId;
  return metadata;
}

export const __testExports = {
  buildMetadata,
  resolveConfiguredProjectId,
};

function extractProjectId(payload: LoadPayload | null): string | undefined {
  if (!payload) return undefined;
  if (typeof payload.cloudaicompanionProject === "string") {
    return payload.cloudaicompanionProject || undefined;
  }
  return payload.cloudaicompanionProject?.id || undefined;
}

function buildIneligibleTierMessage(payload: LoadPayload | null): string | undefined {
  const messages = (payload?.ineligibleTiers || [])
    .map((tier) => tier.reasonMessage?.trim())
    .filter((message): message is string => !!message);

  return messages.length > 0 ? messages.join(", ") : undefined;
}

function throwIfValidationRequired(payload: LoadPayload | null): void {
  const validationTier = payload?.ineligibleTiers?.find((tier) => {
    const reasonCode = tier.reasonCode?.trim().toUpperCase();
    return reasonCode === "VALIDATION_REQUIRED" && !!tier.validationUrl?.trim();
  });

  if (!validationTier) {
    return;
  }

  throw new AccountValidationRequiredError(
    validationTier.reasonMessage?.trim() || "Verify your account to continue.",
    validationTier.validationUrl?.trim(),
  );
}

function getDefaultTierId(payload: LoadPayload | null): string {
  return (
    payload?.allowedTiers?.find((item) => item.isDefault)?.id ||
    payload?.allowedTiers?.[0]?.id ||
    "FREE"
  );
}

async function loadCodeAssist(
  accessToken: string,
  projectId?: string,
  mode: AuthMode = "antigravity",
  userAgentModel?: string,
): Promise<LoadPayload | null> {
  const requestBody: Record<string, unknown> = { metadata: buildMetadata(projectId, mode) };
  if (projectId) {
    requestBody.cloudaicompanionProject = projectId;
  }

  const endpoints = mode === "gemini-cli" ? [PROJECT_ENDPOINTS[0]] : PROJECT_ENDPOINTS;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(mode === "gemini-cli"
            ? {
                "User-Agent": buildGeminiCliUserAgent(userAgentModel),
                "x-activity-request-id": createGeminiCliActivityRequestId(),
              }
            : {
                ...CODE_ASSIST_HEADERS,
                "Client-Metadata": PROJECT_CLIENT_METADATA_HEADER,
              }),
        },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) continue;
      return (await response.json()) as LoadPayload;
    } catch (error) {
      log.debug("loadCodeAssist failed", { endpoint, error: String(error) });
    }
  }
  return null;
}

async function onboardProject(
  accessToken: string,
  tierId: string,
  projectId?: string,
  mode: AuthMode = "antigravity",
  userAgentModel?: string,
): Promise<string | undefined> {
  const requestBody: Record<string, unknown> = {
    tierId,
    metadata: buildMetadata(projectId, mode),
  };
  if (projectId && !isFreeTier(tierId)) {
    requestBody.cloudaicompanionProject = projectId;
  }

  const endpoints = mode === "gemini-cli" ? [REQUEST_ENDPOINTS[0]] : REQUEST_ENDPOINTS;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`${endpoint}/v1internal:onboardUser`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(mode === "gemini-cli"
            ? {
                "User-Agent": buildGeminiCliUserAgent(userAgentModel),
                "x-activity-request-id": createGeminiCliActivityRequestId(),
              }
            : {
                ...getAntigravityHeaders(),
                "Client-Metadata": PROJECT_CLIENT_METADATA_HEADER,
              }),
        },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as {
        done?: boolean;
        response?: { cloudaicompanionProject?: { id?: string } };
      };
      const managedProjectId = payload.response?.cloudaicompanionProject?.id;
      if (payload.done && managedProjectId) return managedProjectId;
      if (payload.done && projectId) return projectId;
    } catch (error) {
      log.debug("onboardUser failed", { endpoint, error: String(error) });
    }
  }
  return undefined;
}

async function resolveGeminiCliProjectContextFromAccessToken(
  accessToken: string,
  preferredProjectId?: string,
  userAgentModel?: string,
): Promise<ProjectResolution> {
  const payload = await loadCodeAssist(
    accessToken,
    preferredProjectId,
    "gemini-cli",
    userAgentModel,
  );
  if (!payload) {
    throw new ProjectIdRequiredError();
  }

  const managedProjectId = extractProjectId(payload);
  if (managedProjectId) {
    return { effectiveProjectId: managedProjectId, managedProjectId };
  }

  const currentTierId = normalizeProjectId(payload.currentTier?.id);
  if (currentTierId) {
    if (preferredProjectId) {
      return { effectiveProjectId: preferredProjectId };
    }

    const ineligibleMessage = buildIneligibleTierMessage(payload);
    if (ineligibleMessage) {
      throw new Error(ineligibleMessage);
    }

    throw new ProjectIdRequiredError();
  }

  throwIfValidationRequired(payload);

  const tierId = getDefaultTierId(payload);
  if (!isFreeTier(tierId) && !preferredProjectId) {
    throw new ProjectIdRequiredError();
  }

  const onboardedProjectId = await onboardProject(
    accessToken,
    tierId,
    preferredProjectId,
    "gemini-cli",
    userAgentModel,
  );
  if (onboardedProjectId) {
    return {
      effectiveProjectId: onboardedProjectId,
      managedProjectId: onboardedProjectId,
    };
  }

  if (preferredProjectId) {
    return { effectiveProjectId: preferredProjectId };
  }

  throw new ProjectIdRequiredError();
}

export async function resolveProjectContextFromAccessToken(
  accessToken: string,
  preferredProjectId?: string,
  mode: AuthMode = "antigravity",
  userAgentModel?: string,
): Promise<ProjectResolution> {
  if (mode === "gemini-cli") {
    return resolveGeminiCliProjectContextFromAccessToken(
      accessToken,
      preferredProjectId,
      userAgentModel,
    );
  }

  const projectCandidates = preferredProjectId
    ? [preferredProjectId, undefined, DEFAULT_PROJECT_ID]
    : [undefined, DEFAULT_PROJECT_ID];

  let lastPayload: LoadPayload | null = null;
  let lastSuccessfulCandidate: string | undefined;
  for (const candidate of projectCandidates) {
    const payload = await loadCodeAssist(accessToken, candidate, mode, userAgentModel);
    if (!payload) continue;
    lastPayload = payload;
    if (candidate !== undefined || lastSuccessfulCandidate === undefined) {
      lastSuccessfulCandidate = candidate;
    }
    const managedProjectId = extractProjectId(payload);
    if (managedProjectId) {
      return { effectiveProjectId: managedProjectId, managedProjectId };
    }
    if (preferredProjectId && candidate === preferredProjectId) {
      return { effectiveProjectId: preferredProjectId };
    }
  }

  const onboarded = await onboardProject(
    accessToken,
    getDefaultTierId(lastPayload),
    lastSuccessfulCandidate,
    mode,
    userAgentModel,
  );
  if (onboarded) {
    return { effectiveProjectId: onboarded, managedProjectId: onboarded };
  }

  const managedProjectId = extractProjectId(lastPayload);
  if (managedProjectId) {
    return { effectiveProjectId: managedProjectId, managedProjectId };
  }

  return { effectiveProjectId: lastSuccessfulCandidate || DEFAULT_PROJECT_ID };
}

export async function resolveProjectId(
  accessToken: string,
  preferredProjectId?: string,
  mode: AuthMode = "antigravity",
  userAgentModel?: string,
): Promise<string> {
  const result = await resolveProjectContextFromAccessToken(
    accessToken,
    preferredProjectId,
    mode,
    userAgentModel,
  );
  return result.effectiveProjectId;
}

export async function ensureProjectContext(
  auth: OAuthAuthState,
  mode: AuthMode = "antigravity",
  configuredProjectId?: string,
  userAgentModel?: string,
): Promise<{ auth: OAuthAuthState; projectId: string }> {
  const configuredProject = normalizeProjectId(configuredProjectId);

  if (!auth.access) {
    return {
      auth,
      projectId: configuredProject || (mode === "antigravity" ? DEFAULT_PROJECT_ID : ""),
    };
  }

  const parts = parseRefreshParts(auth.refresh);
  const packedProjectId = mode === "gemini-cli" && !configuredProject ? undefined : parts.projectId;
  if (
    !configuredProject &&
    parts.managedProjectId &&
    (mode === "antigravity" || !parts.projectId) &&
    parts.managedProjectId !== DEFAULT_PROJECT_ID
  ) {
    return { auth, projectId: parts.managedProjectId };
  }

  if (!configuredProject && packedProjectId) {
    return { auth, projectId: packedProjectId };
  }

  const resolution = await resolveProjectContextFromAccessToken(
    auth.access,
    configuredProject || packedProjectId,
    mode,
    userAgentModel,
  );

  const persistedProjectId = configuredProject || packedProjectId;

  if (!resolution.managedProjectId) {
    if (parts.projectId && !persistedProjectId) {
      return {
        auth: {
          ...auth,
          refresh: formatRefreshParts({
            refreshToken: parts.refreshToken,
          }),
        },
        projectId: resolution.effectiveProjectId,
      };
    }

    if (configuredProject && (parts.projectId !== persistedProjectId || parts.managedProjectId)) {
      return {
        auth: {
          ...auth,
          refresh: formatRefreshParts({
            refreshToken: parts.refreshToken,
            projectId: persistedProjectId,
          }),
        },
        projectId: resolution.effectiveProjectId,
      };
    }

    return { auth, projectId: resolution.effectiveProjectId };
  }

  return {
    auth: {
      ...auth,
      refresh: formatRefreshParts({
        refreshToken: parts.refreshToken,
        projectId: persistedProjectId,
        managedProjectId: resolution.managedProjectId,
      }),
    },
    projectId: resolution.effectiveProjectId,
  };
}
