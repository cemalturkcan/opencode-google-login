import { describe, expect, it } from "bun:test";
import {
  buildAntigravityProviderConfig,
  registerAntigravityModels,
  resolveAntigravityModel,
} from "../src/models.ts";

describe("registerAntigravityModels", () => {
  it("adds Google custom model entries to the provider", async () => {
    const provider = {
      id: "google",
      models: {
        "gemini-3-flash-preview": {
          id: "gemini-3-flash-preview",
          providerID: "google",
          api: { id: "google", url: "https://example.test", npm: "pkg" },
          name: "Gemini 3 Flash Preview",
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: false, pdf: true },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
          },
          cost: { input: 1, output: 1, cache: { read: 1, write: 1 } },
          limit: { context: 1000, output: 1000 },
          status: "active" as const,
          options: {},
          headers: {},
        },
      },
    };

    await registerAntigravityModels(provider, new URL("http://127.0.0.1:4096"));

    expect(provider.models["google-custom-claude-opus-4-6-thinking"]?.name).toBe(
      "Claude Opus 4.6 Thinking (Google custom)",
    );
    expect(provider.models["google-custom-gemini-3-pro"]?.name).toBe(
      "Gemini 3 Pro (Google custom)",
    );
  });
});

describe("resolveAntigravityModel", () => {
  it("maps Opus and Gemini models to backend ids and defaults", () => {
    expect(resolveAntigravityModel("google-custom-claude-opus-4-6-thinking")).toEqual({
      actualModel: "claude-opus-4-6-thinking",
      thinkingBudget: 32768,
      isClaude: true,
    });

    expect(resolveAntigravityModel("google-custom-gemini-3-pro")).toEqual({
      actualModel: "gemini-3-pro-low",
      cliModel: "gemini-3-pro-preview",
      thinkingLevel: "low",
      isClaude: false,
    });

    expect(resolveAntigravityModel("google-custom-gemini-3.1-pro")).toEqual({
      actualModel: "gemini-3.1-pro-low",
      cliModel: "gemini-3.1-pro-preview",
      thinkingLevel: "low",
      isClaude: false,
    });
  });
});

describe("buildAntigravityProviderConfig", () => {
  it("builds a catalog-visible Antigravity provider config", () => {
    const config = buildAntigravityProviderConfig();

    expect(config.name).toBe("Google (custom)");
    expect(config.npm).toBe("@ai-sdk/google");
    expect(config.models["google-custom-claude-opus-4-6-thinking"]?.name).toBe(
      "Claude Opus 4.6 Thinking (Google custom)",
    );
  });

  it("can hide Claude models for CLI-only setups", () => {
    const config = buildAntigravityProviderConfig({ includeClaude: false });

    expect(Object.keys(config.models)).toEqual([
      "google-custom-gemini-3-pro",
      "google-custom-gemini-3.1-pro",
      "google-custom-gemini-3-flash",
    ]);
  });
});
