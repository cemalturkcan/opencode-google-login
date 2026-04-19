import type { Plugin } from "@opencode-ai/plugin";
import {
  clearStoredAntigravityAccounts,
  readStoredAntigravityAccounts,
  removeStoredAntigravityAccount,
  upsertStoredAntigravityAccount,
} from "./account-store.ts";
import { REMOVED_AUTH_SENTINEL, isOAuthAuth, parseRefreshParts } from "./auth-state.ts";
import { PROVIDER_ID } from "./constants.ts";
import {
  clearRefreshInFlight,
  getCurrentRefreshToken,
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
import { resolveConfiguredProjectId } from "./project.ts";

const plugin: Plugin = async ({ client, serverUrl }) => {
  log.info("Plugin initializing");
  let latestConfiguredProjectId: string | undefined;

  async function clearProviderAuth(): Promise<void> {
    const authClient = client.auth as unknown as {
      remove?: (input: unknown) => Promise<unknown>;
      set?: (input: unknown) => Promise<unknown>;
    };

    const attempts = [
      async () => {
        if (typeof authClient.remove !== "function") return false;
        await authClient.remove({ path: { id: PROVIDER_ID } });
        return true;
      },
      async () => {
        if (typeof authClient.remove !== "function") return false;
        await authClient.remove({ path: { providerID: PROVIDER_ID } });
        return true;
      },
      async () => {
        if (typeof authClient.remove !== "function") return false;
        await authClient.remove({ providerID: PROVIDER_ID });
        return true;
      },
      async () => {
        if (typeof authClient.set !== "function") return false;
        await authClient.set({ path: { id: PROVIDER_ID }, body: undefined });
        return true;
      },
    ];

    for (const attempt of attempts) {
      try {
        if (await attempt()) {
          return;
        }
      } catch {}
    }
  }

  function scheduleProviderAuthClear(): void {
    setTimeout(() => {
      void clearProviderAuth();
    }, 0);
  }

  async function resolveLatestConfiguredProjectId(provider?: {
    options?: { projectId?: string };
  }): Promise<string | undefined> {
    latestConfiguredProjectId = resolveConfiguredProjectId({
      provider,
      configProjectId: latestConfiguredProjectId,
    });
    return latestConfiguredProjectId;
  }

  async function resolveVisibilityOptions(forceHide = false) {
    const storedAccounts = await readStoredAntigravityAccounts();
    return {
      includeModels: !forceHide,
      includeClaude: storedAccounts.some((account) => account.kind === "antigravity"),
      storedAccounts,
    };
  }

  return {
    async config(config) {
      latestConfiguredProjectId = resolveConfiguredProjectId({ config });
      const visibility = await resolveVisibilityOptions();
      const baseProviderConfig = buildAntigravityProviderConfig({
        includeModels: true,
        includeClaude: visibility.includeClaude,
      });
      config.provider ??= {};
      config.provider[PROVIDER_ID] = {
        ...baseProviderConfig,
        ...config.provider[PROVIDER_ID],
        options: {
          ...baseProviderConfig.options,
          ...config.provider[PROVIDER_ID]?.options,
        },
        models: baseProviderConfig.models,
      };
    },
    auth: {
      provider: PROVIDER_ID,

      async loader(getAuth: () => Promise<any>, provider: any) {
        const auth = await getAuth();
        const hasRemovedAuth = auth?.type === "oauth" && auth.refresh === REMOVED_AUTH_SENTINEL;
        if (hasRemovedAuth) {
          scheduleProviderAuthClear();
        }
        const configuredProjectId = await resolveLatestConfiguredProjectId(provider);
        const visibility = await resolveVisibilityOptions(hasRemovedAuth);

        if (provider?.models) {
          await registerAntigravityModels(provider, serverUrl, {
            includeModels: visibility.includeModels,
            includeClaude: visibility.includeClaude,
          });
        }

        if (isOAuthAuth(auth)) {
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
            fetch: createCustomFetch(getAuth, client, undefined, async () => configuredProjectId),
          };
        }

        if (getCurrentRefreshToken()) {
          resetRefreshState();
        }
        return {};
      },

      methods: [
        {
          type: "oauth" as const,
          label: "Antigravity (browser)",
          async authorize() {
            const authorization = createAuthorizationRequest(
              await resolveLatestConfiguredProjectId(),
            );

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
            const configuredProjectId = await resolveLatestConfiguredProjectId();
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
                        configuredProjectId,
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
                const exchanged = await exchangeGeminiCliCodeForTokens(
                  parsed.code,
                  parsed.state,
                  configuredProjectId,
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
              },
            };
          },
        },
        ...((await readStoredAntigravityAccounts()).length > 0
          ? [
              {
                type: "oauth" as const,
                label: "Remove saved account",
                prompts: [
                  {
                    type: "select" as const,
                    key: "accountId",
                    message: "Select account to remove",
                    options: (await readStoredAntigravityAccounts()).map((account) => ({
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
                        scheduleProviderAuthClear();
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
                      scheduleProviderAuthClear();
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
