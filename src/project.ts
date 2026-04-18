import { randomUUID } from "node:crypto";
import {
  CODE_ASSIST_HEADERS,
  DEFAULT_PROJECT_ID,
  PROJECT_CLIENT_METADATA_HEADER,
  PROJECT_ENDPOINTS,
  REQUEST_ENDPOINTS,
  getAntigravityHeaders,
} from "./constants.ts";
import { formatRefreshParts, parseRefreshParts, type OAuthAuthState } from "./auth-state.ts";
import { buildGeminiCliUserAgent } from "./gemini-cli.ts";
import { log } from "./logger.ts";

type LoadPayload = {
  cloudaicompanionProject?: string | { id?: string };
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
};

const metadataPlatform = "PLATFORM_UNSPECIFIED";
type AuthMode = "antigravity" | "gemini-cli";

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
};

function extractProjectId(payload: LoadPayload | null): string | undefined {
  if (!payload) return undefined;
  if (typeof payload.cloudaicompanionProject === "string") {
    return payload.cloudaicompanionProject || undefined;
  }
  return payload.cloudaicompanionProject?.id || undefined;
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
): Promise<LoadPayload | null> {
  for (const endpoint of PROJECT_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(mode === "gemini-cli"
            ? {
                "User-Agent": buildGeminiCliUserAgent(),
                "x-activity-request-id": randomUUID(),
              }
            : {
                ...CODE_ASSIST_HEADERS,
                "Client-Metadata": PROJECT_CLIENT_METADATA_HEADER,
              }),
        },
        body: JSON.stringify({ metadata: buildMetadata(projectId, mode) }),
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
): Promise<string | undefined> {
  for (const endpoint of REQUEST_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:onboardUser`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(mode === "gemini-cli"
            ? {
                "User-Agent": buildGeminiCliUserAgent(),
                "x-activity-request-id": randomUUID(),
              }
            : {
                ...getAntigravityHeaders(),
                "Client-Metadata": PROJECT_CLIENT_METADATA_HEADER,
              }),
        },
        body: JSON.stringify({ tierId, metadata: buildMetadata(projectId, mode) }),
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

export async function resolveProjectId(
  accessToken: string,
  preferredProjectId?: string,
  mode: AuthMode = "antigravity",
): Promise<string> {
  const projectCandidates = preferredProjectId
    ? [preferredProjectId, undefined, DEFAULT_PROJECT_ID]
    : [undefined, DEFAULT_PROJECT_ID];

  let lastPayload: LoadPayload | null = null;
  let lastSuccessfulCandidate: string | undefined;
  for (const candidate of projectCandidates) {
    const payload = await loadCodeAssist(accessToken, candidate, mode);
    if (!payload) continue;
    lastPayload = payload;
    lastSuccessfulCandidate = candidate;
    const managedProjectId = extractProjectId(payload);
    if (managedProjectId) return managedProjectId;
  }

  const onboarded = await onboardProject(
    accessToken,
    getDefaultTierId(lastPayload),
    lastSuccessfulCandidate,
    mode,
  );
  return (
    onboarded || extractProjectId(lastPayload) || lastSuccessfulCandidate || DEFAULT_PROJECT_ID
  );
}

export async function ensureProjectContext(
  auth: OAuthAuthState,
  mode: AuthMode = "antigravity",
): Promise<{ auth: OAuthAuthState; projectId: string }> {
  if (!auth.access) {
    return { auth, projectId: DEFAULT_PROJECT_ID };
  }

  const parts = parseRefreshParts(auth.refresh);
  if (parts.managedProjectId && parts.managedProjectId !== DEFAULT_PROJECT_ID) {
    return { auth, projectId: parts.managedProjectId };
  }

  const projectId = await resolveProjectId(auth.access, parts.projectId, mode);
  return {
    auth: {
      ...auth,
      refresh: formatRefreshParts({
        refreshToken: parts.refreshToken,
        projectId: parts.projectId,
        managedProjectId: projectId,
      }),
    },
    projectId,
  };
}
