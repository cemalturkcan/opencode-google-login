import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parseRefreshParts } from "./auth-state.ts";

export type StoredAntigravityAccount = {
  id: string;
  kind: "antigravity" | "gemini-cli";
  email?: string;
  refresh: string;
  access?: string;
  expires?: number;
};

type StoredAccountFile = {
  accounts: StoredAntigravityAccount[];
};

function getStateDir(): string {
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "opencode");
  }
  if (platform() === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  return join(homedir(), ".local", "share", "opencode");
}

function getAccountsFilePath(): string {
  return join(getStateDir(), "antigravity-accounts.json");
}

export function buildAccountId(
  refresh: string,
  _email?: string,
  kind: "antigravity" | "gemini-cli" = "antigravity",
): string {
  const refreshToken = parseRefreshParts(refresh).refreshToken || refresh;
  return createHash("sha256").update(`${kind}:${refreshToken}`).digest("hex").slice(0, 16);
}

export async function readStoredAntigravityAccounts(): Promise<StoredAntigravityAccount[]> {
  try {
    const raw = await readFile(getAccountsFilePath(), "utf8");
    const parsed = JSON.parse(raw) as StoredAccountFile;
    if (!Array.isArray(parsed.accounts)) {
      return [];
    }

    const normalized = parsed.accounts
      .filter(
        (account): account is StoredAntigravityAccount & { kind?: string } =>
          typeof account?.id === "string" && typeof account?.refresh === "string",
      )
      .map(
        (account): StoredAntigravityAccount => ({
          ...account,
          kind: account.kind === "gemini-cli" ? "gemini-cli" : "antigravity",
          id: buildAccountId(
            account.refresh,
            account.email,
            account.kind === "gemini-cli" ? "gemini-cli" : "antigravity",
          ),
        }),
      );

    const deduped: StoredAntigravityAccount[] = [];
    const seen = new Set<string>();
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const account = normalized[index];
      if (seen.has(account.id)) {
        continue;
      }
      seen.add(account.id);
      deduped.unshift(account);
    }

    return deduped;
  } catch {
    return [];
  }
}

export async function writeStoredAntigravityAccounts(
  accounts: StoredAntigravityAccount[],
): Promise<void> {
  await mkdir(getStateDir(), { recursive: true });
  await writeFile(getAccountsFilePath(), JSON.stringify({ accounts }, null, 2));
}

export async function upsertStoredAntigravityAccount(
  input: Omit<StoredAntigravityAccount, "id">,
): Promise<StoredAntigravityAccount[]> {
  const nextAccount: StoredAntigravityAccount = {
    id: buildAccountId(input.refresh, input.email, input.kind),
    ...input,
  };

  const current = await readStoredAntigravityAccounts();
  const normalizedCurrent = current.map((account) => ({
    ...account,
    id: buildAccountId(account.refresh, account.email, account.kind),
  }));
  const seen = new Set<string>([nextAccount.id]);
  const deduped = normalizedCurrent.filter((account) => {
    if (account.id === nextAccount.id) {
      return false;
    }
    if (seen.has(account.id)) {
      return false;
    }
    seen.add(account.id);
    return true;
  });
  const updated = [nextAccount, ...deduped];
  await writeStoredAntigravityAccounts(updated);
  return updated;
}

export async function removeStoredAntigravityAccount(
  id: string,
): Promise<StoredAntigravityAccount[]> {
  const current = await readStoredAntigravityAccounts();
  const updated = current.filter((account) => account.id !== id);
  await writeStoredAntigravityAccounts(updated);
  return updated;
}

export async function clearStoredAntigravityAccounts(): Promise<void> {
  await writeStoredAntigravityAccounts([]);
}

export const __testExports = {
  buildAccountId,
};
