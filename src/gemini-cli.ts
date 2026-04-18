import { createHash, randomBytes } from "node:crypto";
import {
  GEMINI_CLI_CLIENT_ID,
  GEMINI_CLI_CLIENT_SECRET,
  GEMINI_CLI_REDIRECT_URI,
  GEMINI_CLI_SCOPES,
  TOKEN_URL,
} from "./constants.ts";
import { formatRefreshParts } from "./auth-state.ts";
import { readUserEmail } from "./credentials.ts";
import { resolveProjectContextFromAccessToken } from "./project.ts";

type OAuthState = { verifier: string };

export type GeminiCliAuthorizeResult = { url: string; state: string };

export type GeminiCliExchangeResult =
  | ({ type: "success" } & {
      refresh: string;
      access: string;
      expires: number;
      email?: string;
      kind: "gemini-cli";
    })
  | { type: "failed"; error: string };

const GEMINI_CLI_VERSION = "0.30.0-nightly.20260210.a2174751d";

export function buildGeminiCliUserAgent(model = "gemini-code-assist"): string {
  return `GeminiCLI/${GEMINI_CLI_VERSION}/${model} (${process.platform}; ${process.arch})`;
}

export function createGeminiCliActivityRequestId(): string {
  return Math.random().toString(36).substring(7);
}

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

export function createGeminiCliAuthorizationRequest(): GeminiCliAuthorizeResult {
  const verifier = createVerifier();
  const state = encodeState({ verifier });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GEMINI_CLI_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", GEMINI_CLI_REDIRECT_URI);
  url.searchParams.set("scope", GEMINI_CLI_SCOPES.join(" "));
  url.searchParams.set("code_challenge", createChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

export async function exchangeGeminiCliCodeForTokens(
  code: string,
  state: string,
  preferredProjectId?: string,
  userAgentModel?: string,
): Promise<GeminiCliExchangeResult> {
  try {
    const decoded = decodeState(state);
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({
        client_id: GEMINI_CLI_CLIENT_ID,
        client_secret: GEMINI_CLI_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: GEMINI_CLI_REDIRECT_URI,
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
      return { type: "failed", error: "Missing refresh token in Gemini CLI OAuth response" };
    }

    const projectContext = await resolveProjectContextFromAccessToken(
      payload.access_token,
      preferredProjectId,
      "gemini-cli",
      userAgentModel,
    );
    const email = await readUserEmail(payload.access_token);

    return {
      type: "success",
      access: payload.access_token,
      refresh: formatRefreshParts({
        refreshToken: payload.refresh_token,
        projectId: preferredProjectId,
        managedProjectId: projectContext.managedProjectId,
      }),
      expires: Date.now() + payload.expires_in * 1000,
      email,
      kind: "gemini-cli",
    };
  } catch (error) {
    return {
      type: "failed",
      error: error instanceof Error ? error.message : "Unknown Gemini CLI OAuth exchange error",
    };
  }
}

export async function refreshGeminiCliTokens(refreshToken: string): Promise<{
  access: string;
  refresh: string;
  expires: number;
}> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: GEMINI_CLI_CLIENT_ID,
      client_secret: GEMINI_CLI_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Gemini CLI token refresh failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const payload = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    access: payload.access_token,
    refresh: payload.refresh_token ?? refreshToken,
    expires: Date.now() + payload.expires_in * 1000,
  };
}
