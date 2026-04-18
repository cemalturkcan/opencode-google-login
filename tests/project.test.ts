import { afterEach, describe, expect, it } from "bun:test";
import { __testExports, ensureProjectContext } from "../src/project.ts";

describe("buildMetadata", () => {
  it("uses the accepted platform enum for loadCodeAssist", () => {
    expect(__testExports.buildMetadata()).toEqual({
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    });
  });
});

describe("ensureProjectContext", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("re-resolves stale default managed project ids", async () => {
    let capturedBody = "";
    let capturedHeader = "";

    globalThis.fetch = (async (_input, init) => {
      capturedBody = String(init?.body || "");
      capturedHeader = String(new Headers(init?.headers).get("Client-Metadata") || "");
      return new Response(
        JSON.stringify({
          cloudaicompanionProject: { id: "managed-project-456" },
          allowedTiers: [{ id: "FREE", isDefault: true }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const result = await ensureProjectContext({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token||rising-fact-p41fc",
      expires: Date.now() + 60_000,
    });

    expect(result.projectId).toBe("managed-project-456");
    expect(result.auth.refresh).toBe("refresh-token||managed-project-456");
    expect(JSON.parse(capturedBody)).toEqual({
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    });
    expect(capturedHeader).toBe(
      '{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
    );
  });
});
