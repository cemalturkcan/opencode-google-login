import { REFRESH_BUFFER_MS } from "./constants.ts";

export const REMOVED_AUTH_SENTINEL = "__removed__";

export type OAuthAuthState = {
  type: "oauth";
  refresh: string;
  access?: string;
  expires?: number;
  email?: string;
  kind?: "antigravity" | "gemini-cli";
};

export type AuthState = {
  type: string;
  refresh?: string;
  access?: string;
  expires?: number;
  email?: string;
  kind?: "antigravity" | "gemini-cli";
};

export type RefreshParts = {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
};

export function isOAuthAuth(auth: AuthState): auth is OAuthAuthState {
  return (
    auth.type === "oauth" &&
    typeof auth.refresh === "string" &&
    auth.refresh.trim().length > 0 &&
    auth.refresh !== REMOVED_AUTH_SENTINEL
  );
}

export function parseRefreshParts(refresh: string): RefreshParts {
  const [refreshToken = "", projectId = "", managedProjectId = ""] = refresh.split("|");
  return {
    refreshToken,
    projectId: projectId || undefined,
    managedProjectId: managedProjectId || undefined,
  };
}

export function formatRefreshParts(parts: RefreshParts): string {
  const base = `${parts.refreshToken}|${parts.projectId ?? ""}`;
  return parts.managedProjectId ? `${base}|${parts.managedProjectId}` : base;
}

export function needsRefresh(auth: OAuthAuthState): boolean {
  return !auth.access || !auth.expires || auth.expires <= Date.now() + REFRESH_BUFFER_MS;
}
