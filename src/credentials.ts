import { access } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  APP_STATE_KEY,
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

type ImportedTokens = {
  access?: string;
  refresh: string;
};

export const APP_STATE_REFRESH_TOKEN = "__antigravity_app_state__";

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function getStateDbPath(): string {
  if (platform() === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Antigravity",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  if (platform() === "win32") {
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "Antigravity",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  return join(homedir(), ".config", "Antigravity", "User", "globalStorage", "state.vscdb");
}

function scanSerializedState(blob: string): ImportedTokens | null {
  const queue = [blob];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    const access = current.match(/ya29\.[A-Za-z0-9._-]+/)?.[0];
    const refresh = current.match(/(?:g1|1)\/\/[A-Za-z0-9._-]+/)?.[0];
    if (refresh) {
      return { access, refresh };
    }

    if (!/^[A-Za-z0-9_-]{24,}$/.test(current)) {
      continue;
    }

    try {
      const decoded = decodeBase64Url(current);
      const printable = Buffer.from(decoded).toString("latin1");
      queue.push(printable);
      for (const match of printable.matchAll(/[A-Za-z0-9._:/?=-]{12,}/g)) {
        if (match[0]) queue.push(match[0]);
      }
      for (const match of printable.matchAll(/[A-Za-z0-9_-]{24,}/g)) {
        if (match[0]) queue.push(match[0]);
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function readInstalledStateValue(): Promise<string | null> {
  const dbPath = getStateDbPath();
  try {
    await access(dbPath);
  } catch {
    return null;
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query("select value from ItemTable where key = ?1").get(APP_STATE_KEY) as {
        value?: string;
      } | null;
      return typeof row?.value === "string" ? row.value : null;
    } finally {
      db.close();
    }
  } catch (error) {
    log.warn("Failed to read Antigravity state database", { error: String(error), dbPath });
    return null;
  }
}

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

export async function hasInstalledAntigravityApp(): Promise<boolean> {
  try {
    await access(getStateDbPath());
    return true;
  } catch {
    return false;
  }
}

export async function readInstalledAntigravityTokens(): Promise<ImportedTokens | null> {
  const value = await readInstalledStateValue();
  if (!value) return null;
  return scanSerializedState(value);
}

export async function importInstalledAntigravityCredentials(): Promise<OAuthTokens | null> {
  const tokens = await readInstalledAntigravityTokens();
  if (!tokens) return null;

  if (tokens.refresh) {
    try {
      return await refreshTokensSafe(tokens.refresh);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        tokens.access &&
        (message.includes("unauthorized_client") || message.includes("401 Unauthorized"))
      ) {
        log.info(
          "Installed app refresh token is bound to a different client, using access token fallback",
        );
        return {
          access: tokens.access,
          refresh: APP_STATE_REFRESH_TOKEN,
          expires: Date.now() + 60_000,
        };
      }
      throw error;
    }
  }

  if (!tokens.access) return null;

  return {
    access: tokens.access,
    refresh: APP_STATE_REFRESH_TOKEN,
    expires: Date.now() + 60_000,
  };
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

export const __testExports = {
  scanSerializedState,
};
