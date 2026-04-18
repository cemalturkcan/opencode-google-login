import { afterEach, describe, expect, it } from "bun:test";
import { __testExports, createCustomFetch } from "../src/fetch.ts";

describe("createCustomFetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rewrites Google provider requests to Antigravity", async () => {
    let calledUrl = "";
    let calledBody = "";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calledUrl = String(input);
      calledBody = String(init?.body || "");
      return new Response('{"response":{"candidates":[{"content":{"parts":[]}}]}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const customFetch = createCustomFetch(
      async () => ({
        type: "oauth",
        kind: "antigravity",
        access: "access-token",
        refresh: "refresh-token|project-123|managed-project-456",
        expires: Date.now() + 10 * 60_000,
        email: "test@example.com",
      }),
      {
        auth: {
          set: async () => {},
        },
      },
    );

    const response = await customFetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-antigravity-model-id": "antigravity-claude-sonnet-4-6",
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
      },
    );

    expect(calledUrl).toContain("/v1internal:generateContent");
    expect(JSON.parse(calledBody).project).toBe("managed-project-456");
    expect(await response.text()).toBe('{"candidates":[{"content":{"parts":[]}}]}');
  });
});

describe("getAccountKey", () => {
  it("normalizes packed refresh values to the same account key", () => {
    expect(__testExports.getAccountKey("refresh-token||project-a")).toBe(
      __testExports.getAccountKey("refresh-token||project-b"),
    );
  });
});
