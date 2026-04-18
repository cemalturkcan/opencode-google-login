import { createHash, randomBytes } from "node:crypto";
import {
  AUTHORIZE_URL,
  CLIENT_ID,
  CLIENT_SECRET,
  OAUTH_SCOPES,
  REDIRECT_URI,
  TOKEN_URL,
  type OAuthTokens,
} from "./constants.ts";
import { formatRefreshParts } from "./auth-state.ts";
import { readUserEmail } from "./credentials.ts";
import { log } from "./logger.ts";
import { resolveProjectId } from "./project.ts";

type OAuthState = {
  verifier: string;
  projectId?: string;
};

export type OAuthAuthorizeResult = {
  url: string;
  state: string;
};

export type OAuthExchangeResult =
  | ({ type: "success" } & OAuthTokens & { email?: string })
  | { type: "failed"; error: string };

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function encodeState(state: OAuthState): string {
  return base64Url(JSON.stringify(state));
}

function decodeState(state: string): OAuthState {
  const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as OAuthState;
  if (typeof parsed.verifier !== "string" || parsed.verifier.length === 0) {
    throw new Error("OAuth state is missing the PKCE verifier");
  }
  return parsed;
}

function createVerifier(): string {
  return base64Url(randomBytes(32));
}

function createChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function parseCallbackParams(input: string): URLSearchParams {
  const trimmed = input.trim();
  if (!trimmed) return new URLSearchParams();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return new URL(trimmed).searchParams;
  }
  if (trimmed.startsWith("?")) {
    return new URLSearchParams(trimmed.slice(1));
  }
  if (trimmed.includes("=")) {
    return new URLSearchParams(trimmed.replace(/^\?/, ""));
  }
  return new URLSearchParams();
}

export function createAuthorizationRequest(projectId = ""): OAuthAuthorizeResult {
  const verifier = createVerifier();
  const state = encodeState({ verifier, projectId: projectId || undefined });
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("code_challenge", createChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

export function parseCallbackInput(
  input: string,
  fallbackState: string,
): { code: string; state: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "OAuth callback input is empty" };

  const params = parseCallbackParams(trimmed);
  const error = params.get("error");
  if (error) return { error: `OAuth error: ${error}` };

  const structuredInput = params.size > 0;
  const code = params.get("code") ?? (params.size > 0 ? "" : trimmed);
  if (!code) return { error: "OAuth callback URL is missing a code parameter" };

  const callbackState = params.get("state");
  if (structuredInput && callbackState !== fallbackState) {
    return { error: "OAuth state mismatch" };
  }

  return {
    code,
    state: fallbackState,
  };
}

export async function exchangeCodeForTokens(
  code: string,
  state: string,
): Promise<OAuthExchangeResult> {
  try {
    const decoded = decodeState(state);
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code_verifier: decoded.verifier,
      }),
    });

    if (!response.ok) {
      return { type: "failed", error: await response.text() };
    }

    const payload = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    if (!payload.refresh_token) {
      return { type: "failed", error: "Missing refresh token in Google OAuth response" };
    }

    const managedProjectId = await resolveProjectId(payload.access_token, decoded.projectId);
    const email = await readUserEmail(payload.access_token);

    return {
      type: "success",
      access: payload.access_token,
      refresh: formatRefreshParts({
        refreshToken: payload.refresh_token,
        projectId: decoded.projectId,
        managedProjectId,
      }),
      expires: Date.now() + payload.expires_in * 1000,
      email,
    };
  } catch (error) {
    log.error("Google OAuth exchange failed", { error: String(error) });
    return {
      type: "failed",
      error: error instanceof Error ? error.message : "Unknown OAuth exchange error",
    };
  }
}
