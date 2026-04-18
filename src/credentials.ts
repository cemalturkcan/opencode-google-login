import {
  CLIENT_ID,
  CLIENT_SECRET,
  TOKEN_URL,
  USERINFO_URL,
  type OAuthTokens,
} from "./constants.ts";
import { fetchWithRetry } from "./http.ts";
import { log } from "./logger.ts";

let currentRefreshToken: string | null = null;
let refreshInFlight: Promise<OAuthTokens> | null = null;

async function refreshTokens(refreshToken: string): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const response = await fetchWithRetry(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Token refresh failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const payload = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (typeof payload.access_token !== "string" || typeof payload.expires_in !== "number") {
    throw new Error("Token refresh returned an invalid payload");
  }

  return {
    access: payload.access_token,
    refresh: payload.refresh_token ?? refreshToken,
    expires: Date.now() + payload.expires_in * 1000,
  };
}

export function getCurrentRefreshToken(): string | null {
  return currentRefreshToken;
}

export function setCurrentRefreshToken(token: string | null): void {
  currentRefreshToken = token;
}

export function resetRefreshState(): void {
  currentRefreshToken = null;
  refreshInFlight = null;
}

export function clearRefreshInFlight(): void {
  refreshInFlight = null;
}

export function refreshTokensSafe(refreshToken: string): Promise<OAuthTokens> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshTokens(refreshToken).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export async function readUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { email?: string };
    return payload.email;
  } catch (error) {
    log.debug("Failed to read Google user info", { error: String(error) });
    return undefined;
  }
}
