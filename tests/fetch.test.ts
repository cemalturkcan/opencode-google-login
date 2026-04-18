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
          "x-antigravity-model-id": "google-custom-claude-sonnet-4-6",
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
      },
    );

    expect(calledUrl).toContain("/v1internal:generateContent");
    expect(JSON.parse(calledBody).project).toBe("managed-project-456");
    expect(await response.text()).toBe('{"candidates":[{"content":{"parts":[]}}]}');
  });

  it("falls back from gemini-cli permission denial to antigravity", async () => {
    let callCount = 0;

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      const authHeader = String(new Headers(init?.headers).get("authorization") || "");

      if (authHeader === "Bearer cli-access") {
        return new Response("The caller does not have permission", {
          status: 403,
          headers: { "content-type": "text/plain" },
        });
      }

      return new Response('{"response":{"candidates":[{"content":{"parts":[]}}]}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const customFetch = createCustomFetch(
      async () => ({
        type: "oauth",
        kind: "gemini-cli",
        access: "cli-access",
        refresh: "cli-refresh|project-123|managed-project-456",
        expires: Date.now() + 10 * 60_000,
        email: "cli@example.com",
      }),
      {
        auth: {
          set: async () => {},
        },
      },
      async () => [
        {
          id: "antigravity-1",
          kind: "antigravity",
          access: "ant-access",
          refresh: "ant-refresh|project-123|managed-project-999",
          expires: Date.now() + 10 * 60_000,
          email: "ant@example.com",
        },
      ],
    );

    const response = await customFetch(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-gemini-3.1-pro:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-antigravity-model-id": "google-custom-gemini-3.1-pro",
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
      },
    );

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"candidates":[{"content":{"parts":[]}}]}');
  });

  it("surfaces gemini-cli project resolution errors when no fallback account exists", async () => {
    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;

    const customFetch = createCustomFetch(
      async () => ({
        type: "oauth",
        kind: "gemini-cli",
        access: "cli-access",
        refresh: "cli-refresh",
        expires: Date.now() + 10 * 60_000,
        email: "cli@example.com",
      }),
      {
        auth: {
          set: async () => {},
        },
      },
      async () => [],
    );

    await expect(
      customFetch(
        "https://generativelanguage.googleapis.com/v1beta/models/google-custom-gemini-3.1-pro:generateContent",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-antigravity-model-id": "google-custom-gemini-3.1-pro",
          },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
        },
      ),
    ).rejects.toThrow("could not resolve a usable Code Assist project");
  });

  it("falls back past an invalid antigravity account after auth failure", async () => {
    let realRefreshCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://oauth2.googleapis.com/token") {
        const body = String(init?.body || "");
        if (body.includes("refresh_token=fake-refresh")) {
          return new Response("forbidden", { status: 403, statusText: "Forbidden" });
        }

        if (body.includes("refresh_token=real-refresh")) {
          realRefreshCalls += 1;
          return new Response(
            JSON.stringify({
              access_token: "real-access-refreshed",
              expires_in: 3600,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
      }

      const authHeader = String(new Headers(init?.headers).get("authorization") || "");
      if (authHeader === "Bearer fake-access") {
        return new Response(
          "Request had invalid authentication credentials. Expected OAuth 2 access token",
          {
            status: 401,
            headers: { "content-type": "text/plain" },
          },
        );
      }

      return new Response('{"response":{"candidates":[{"content":{"parts":[]}}]}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const customFetch = createCustomFetch(
      async () => ({
        type: "oauth",
        kind: "antigravity",
        access: "fake-access",
        refresh: "fake-refresh||managed-project-123",
        expires: Date.now() + 10 * 60_000,
        email: "fake@example.com",
      }),
      {
        auth: {
          set: async () => {},
        },
      },
      async () => [
        {
          id: "real-antigravity",
          kind: "antigravity",
          access: "real-access",
          refresh: "real-refresh||managed-project-999",
          expires: Date.now() - 1_000,
          email: "real@example.com",
        },
      ],
    );

    const response = await customFetch(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-gemini-3.1-pro:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-antigravity-model-id": "google-custom-gemini-3.1-pro",
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
      },
    );

    expect(realRefreshCalls).toBe(1);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"candidates":[{"content":{"parts":[]}}]}');
  });
});

describe("getAccountKey", () => {
  it("normalizes packed refresh values to the same account key", () => {
    expect(__testExports.getAccountKey("refresh-token||project-a")).toBe(
      __testExports.getAccountKey("refresh-token||project-b"),
    );
  });

  it("keeps antigravity and gemini-cli paths distinct for the same refresh token", () => {
    expect(__testExports.getAccountKey("refresh-token", undefined, "antigravity")).not.toBe(
      __testExports.getAccountKey("refresh-token", undefined, "gemini-cli"),
    );
  });
});
