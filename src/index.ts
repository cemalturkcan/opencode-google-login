import type { Plugin } from "@opencode-ai/plugin";
import {
  clearStoredAntigravityAccounts,
  readStoredAntigravityAccounts,
  removeStoredAntigravityAccount,
  upsertStoredAntigravityAccount,
} from "./account-store.ts";
import {
  REMOVED_AUTH_SENTINEL,
  formatRefreshParts,
  isOAuthAuth,
  parseRefreshParts,
} from "./auth-state.ts";
import { PROVIDER_ID } from "./constants.ts";
import {
  clearRefreshInFlight,
  getCurrentRefreshToken,
  hasInstalledAntigravityApp,
  importInstalledAntigravityCredentials,
  resetRefreshState,
  setCurrentRefreshToken,
} from "./credentials.ts";
import { log } from "./logger.ts";
import { createCustomFetch } from "./fetch.ts";
import {
  createGeminiCliAuthorizationRequest,
  exchangeGeminiCliCodeForTokens,
} from "./gemini-cli.ts";
import { createAuthorizationRequest, exchangeCodeForTokens, parseCallbackInput } from "./oauth.ts";
import { GEMINI_CLI_REDIRECT_URI } from "./constants.ts";
import { openBrowser } from "./open-browser.ts";
import { shouldUseManualOAuthFlow, startOAuthListener } from "./oauth-server.ts";
import { buildAntigravityProviderConfig, registerAntigravityModels } from "./models.ts";
import { resolveProjectId } from "./project.ts";

const plugin: Plugin = async ({ client, serverUrl }) => {
  log.info("Plugin initializing");
  const hasInstalledApp = await hasInstalledAntigravityApp();
  const storedAccounts = await readStoredAntigravityAccounts();
  const includeClaudeModels = storedAccounts.some((account) => account.kind === "antigravity");

  async function clearProviderAuth(): Promise<void> {
    const removable = client.auth as unknown as {
      remove?: (input: { path: { providerID: string } }) => Promise<unknown>;
    };
    if (typeof removable.remove === "function") {
      await removable.remove({ path: { providerID: PROVIDER_ID } }).catch(() => {});
    }
  }

  return {
    async config(config) {
      const baseProviderConfig = buildAntigravityProviderConfig({
        includeClaude: includeClaudeModels,
      });
      config.provider ??= {};
      config.provider[PROVIDER_ID] = {
        ...baseProviderConfig,
        ...config.provider[PROVIDER_ID],
        models: {
          ...baseProviderConfig.models,
          ...config.provider[PROVIDER_ID]?.models,
        },
      };
    },
    auth: {
      provider: PROVIDER_ID,

      async loader(getAuth: () => Promise<any>, provider: any) {
        const auth = await getAuth();

        if (isOAuthAuth(auth)) {
          if (provider?.models) {
            await registerAntigravityModels(provider, serverUrl);
          }

          const refreshToken = parseRefreshParts(auth.refresh).refreshToken;
          if (refreshToken && refreshToken !== getCurrentRefreshToken()) {
            clearRefreshInFlight();
            setCurrentRefreshToken(refreshToken);
          }

          if (provider?.models) {
            for (const model of Object.values(provider.models) as any[]) {
              model.cost = {
                input: 0,
                output: 0,
                cache: { read: 0, write: 0 },
              };
            }
          }

          return {
            apiKey: "",
            fetch: createCustomFetch(getAuth, client),
          };
        }

        if (getCurrentRefreshToken()) {
          resetRefreshState();
        }
        return {};
      },

      methods: [
        ...(hasInstalledApp
          ? [
              {
                type: "oauth" as const,
                label: "Antigravity app (auto)",
                async authorize() {
                  return {
                    url: "",
                    instructions:
                      "Importing the OAuth session from your installed Antigravity app.",
                    method: "auto" as const,
                    async callback() {
                      const tokens = await importInstalledAntigravityCredentials();
                      if (!tokens) {
                        return {
                          type: "failed" as const,
                          error: "No reusable Antigravity app credentials were found.",
                        };
                      }

                      const managedProjectId = await resolveProjectId(tokens.access);
                      await upsertStoredAntigravityAccount({
                        kind: "antigravity",
                        access: tokens.access,
                        refresh: formatRefreshParts({
                          refreshToken: tokens.refresh,
                          managedProjectId,
                        }),
                        expires: tokens.expires,
                      });
                      return {
                        type: "success" as const,
                        access: tokens.access,
                        refresh: formatRefreshParts({
                          refreshToken: tokens.refresh,
                          managedProjectId,
                        }),
                        expires: tokens.expires,
                        kind: "antigravity" as const,
                      };
                    },
                  };
                },
              },
            ]
          : []),
        {
          type: "oauth" as const,
          label: "Antigravity (browser)",
          async authorize() {
            const authorization = createAuthorizationRequest();

            if (!shouldUseManualOAuthFlow()) {
              const listener = await startOAuthListener().catch(() => null);
              if (listener) {
                openBrowser(authorization.url);
                return {
                  url: authorization.url,
                  instructions:
                    "Complete Google sign-in in your browser. The localhost callback will be captured automatically.",
                  method: "auto" as const,
                  async callback() {
                    try {
                      const callbackUrl = await listener.waitForCallback();
                      const parsed = parseCallbackInput(
                        callbackUrl.toString(),
                        authorization.state,
                      );
                      if ("error" in parsed) {
                        return { type: "failed" as const, error: parsed.error };
                      }
                      const exchanged = await exchangeCodeForTokens(parsed.code, parsed.state);
                      if (exchanged.type === "success") {
                        await upsertStoredAntigravityAccount({
                          kind: "antigravity",
                          access: exchanged.access,
                          refresh: exchanged.refresh,
                          expires: exchanged.expires,
                          email: exchanged.email,
                        });
                      }
                      return exchanged.type === "success"
                        ? { ...exchanged, kind: "antigravity" as const }
                        : exchanged;
                    } catch (error) {
                      return {
                        type: "failed" as const,
                        error: error instanceof Error ? error.message : "OAuth callback failed",
                      };
                    } finally {
                      await listener.close().catch(() => {});
                    }
                  },
                };
              }
            }

            return {
              url: authorization.url,
              instructions:
                "Open the link above, finish Google OAuth, then paste the full callback URL or the code here.",
              method: "code" as const,
              async callback(input: string) {
                const parsed = parseCallbackInput(input, authorization.state);
                if ("error" in parsed) {
                  return { type: "failed" as const, error: parsed.error };
                }
                const exchanged = await exchangeCodeForTokens(parsed.code, parsed.state);
                if (exchanged.type === "success") {
                  await upsertStoredAntigravityAccount({
                    kind: "antigravity",
                    access: exchanged.access,
                    refresh: exchanged.refresh,
                    expires: exchanged.expires,
                    email: exchanged.email,
                  });
                }
                return exchanged.type === "success"
                  ? { ...exchanged, kind: "antigravity" as const }
                  : exchanged;
              },
            };
          },
        },
        {
          type: "oauth" as const,
          label: "Google (Gemini CLI)",
          async authorize() {
            const authorization = createGeminiCliAuthorizationRequest();

            if (!shouldUseManualOAuthFlow()) {
              const listener = await startOAuthListener(
                5 * 60 * 1000,
                GEMINI_CLI_REDIRECT_URI,
              ).catch(() => null);
              if (listener) {
                openBrowser(authorization.url);
                return {
                  url: authorization.url,
                  instructions:
                    "Complete Google sign-in in your browser. The Gemini CLI localhost callback will be captured automatically.",
                  method: "auto" as const,
                  async callback() {
                    try {
                      const callbackUrl = await listener.waitForCallback();
                      const parsed = parseCallbackInput(
                        callbackUrl.toString(),
                        authorization.state,
                      );
                      if ("error" in parsed) {
                        return { type: "failed" as const, error: parsed.error };
                      }
                      const exchanged = await exchangeGeminiCliCodeForTokens(
                        parsed.code,
                        parsed.state,
                      );
                      if (exchanged.type === "success") {
                        await upsertStoredAntigravityAccount({
                          kind: "gemini-cli",
                          access: exchanged.access,
                          refresh: exchanged.refresh,
                          expires: exchanged.expires,
                          email: exchanged.email,
                        });
                      }
                      return exchanged;
                    } catch (error) {
                      return {
                        type: "failed" as const,
                        error: error instanceof Error ? error.message : "OAuth callback failed",
                      };
                    } finally {
                      await listener.close().catch(() => {});
                    }
                  },
                };
              }
            }

            return {
              url: authorization.url,
              instructions:
                "Open the link above, finish Google OAuth, then paste the full callback URL or the code here.",
              method: "code" as const,
              async callback(input: string) {
                const parsed = parseCallbackInput(input, authorization.state);
                if ("error" in parsed) {
                  return { type: "failed" as const, error: parsed.error };
                }
                const exchanged = await exchangeGeminiCliCodeForTokens(parsed.code, parsed.state);
                if (exchanged.type === "success") {
                  await upsertStoredAntigravityAccount({
                    kind: "gemini-cli",
                    access: exchanged.access,
                    refresh: exchanged.refresh,
                    expires: exchanged.expires,
                    email: exchanged.email,
                  });
                }
                return exchanged;
              },
            };
          },
        },
        ...(storedAccounts.length > 0
          ? [
              {
                type: "oauth" as const,
                label: "Remove saved account",
                prompts: [
                  {
                    type: "select" as const,
                    key: "accountId",
                    message: "Select account to remove",
                    options: storedAccounts.map((account) => ({
                      label: account.email || `${account.kind}:${account.id}`,
                      value: account.id,
                      hint: account.kind,
                    })),
                  },
                ],
                async authorize(inputs?: Record<string, string>) {
                  const accountId = inputs?.accountId;
                  return {
                    url: "",
                    instructions: "Removing the selected saved account.",
                    method: "auto" as const,
                    async callback() {
                      if (!accountId) {
                        return { type: "failed" as const, error: "No account selected." };
                      }

                      const updated = await removeStoredAntigravityAccount(accountId);
                      const next = updated[0];

                      if (!next) {
                        await clearProviderAuth();
                        return {
                          type: "success" as const,
                          access: "",
                          refresh: REMOVED_AUTH_SENTINEL,
                          expires: 0,
                          kind: "antigravity" as const,
                        };
                      }

                      return {
                        type: "success" as const,
                        access: next.access || "",
                        refresh: next.refresh,
                        expires: next.expires || 0,
                        email: next.email,
                        kind: next.kind,
                      };
                    },
                  };
                },
              },
              {
                type: "oauth" as const,
                label: "Remove all saved accounts",
                async authorize() {
                  return {
                    url: "",
                    instructions: "Removing all saved accounts.",
                    method: "auto" as const,
                    async callback() {
                      await clearStoredAntigravityAccounts();
                      await clearProviderAuth();
                      return {
                        type: "success" as const,
                        access: "",
                        refresh: REMOVED_AUTH_SENTINEL,
                        expires: 0,
                        kind: "antigravity" as const,
                      };
                    },
                  };
                },
              },
            ]
          : []),
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== PROVIDER_ID) {
        return;
      }

      output.headers["x-antigravity-model-id"] = input.model.id;
    },
  };
};

export default plugin;
