import { afterEach, describe, expect, it } from "bun:test";
import {
  __testExports,
  ProjectIdRequiredError,
  ensureProjectContext,
  resolveProjectId,
} from "../src/project.ts";

describe("buildMetadata", () => {
  it("uses the accepted platform enum for loadCodeAssist", () => {
    expect(__testExports.buildMetadata()).toEqual({
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    });
  });

  it("resolves configured project ids from provider, config, and env", () => {
    expect(
      __testExports.resolveConfiguredProjectId({
        provider: { options: { projectId: "provider-project" } },
      }),
    ).toBe("provider-project");

    expect(
      __testExports.resolveConfiguredProjectId({
        config: { provider: { antigravity: { options: { projectId: "config-project" } } } },
      }),
    ).toBe("config-project");

    expect(
      __testExports.resolveConfiguredProjectId({
        env: { OPENCODE_GEMINI_PROJECT_ID: "env-project" } as NodeJS.ProcessEnv,
      }),
    ).toBe("env-project");
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

  it("keeps a configured Antigravity project when no managed project is returned", async () => {
    let capturedBody = "";

    globalThis.fetch = (async (_input, init) => {
      capturedBody = String(init?.body || "");
      return new Response(
        JSON.stringify({
          currentTier: { id: "standard-tier" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const result = await ensureProjectContext(
      {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
      "antigravity",
      "configured-project",
    );

    expect(result.projectId).toBe("configured-project");
    expect(result.auth.refresh).toBe("refresh-token|configured-project");
    expect(JSON.parse(capturedBody)).toEqual({
      cloudaicompanionProject: "configured-project",
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
        duetProject: "configured-project",
      },
    });
  });

  it("throws for gemini-cli when no usable project can be resolved", async () => {
    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;

    await expect(resolveProjectId("access-token", undefined, "gemini-cli")).rejects.toBeInstanceOf(
      ProjectIdRequiredError,
    );
  });

  it("does not fall back to the default project for gemini-cli free-tier onboarding", async () => {
    const bodies: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      bodies.push(JSON.parse(rawBody) as Record<string, unknown>);

      if (url.includes(":loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            allowedTiers: [{ id: "free-tier", isDefault: true }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url.includes(":onboardUser")) {
        return new Response(
          JSON.stringify({
            done: true,
            response: { cloudaicompanionProject: { id: "managed-project-789" } },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const projectId = await resolveProjectId("access-token", undefined, "gemini-cli");

    expect(projectId).toBe("managed-project-789");
    expect(bodies[0]?.cloudaicompanionProject).toBeUndefined();
    expect(
      (bodies[0]?.metadata as Record<string, unknown> | undefined)?.duetProject,
    ).toBeUndefined();
    expect(bodies[1]?.cloudaicompanionProject).toBeUndefined();
  });

  it("keeps a usable preferred project for gemini-cli paid-tier onboarding", async () => {
    const bodies: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      bodies.push(JSON.parse(rawBody) as Record<string, unknown>);

      if (url.includes(":loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            allowedTiers: [{ id: "standard-tier", isDefault: true }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url.includes(":onboardUser")) {
        return new Response(
          JSON.stringify({
            done: true,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const projectId = await resolveProjectId("access-token", "preferred-project", "gemini-cli");

    expect(projectId).toBe("preferred-project");
    expect(bodies[0]?.cloudaicompanionProject).toBe("preferred-project");
    expect(bodies[1]?.cloudaicompanionProject).toBe("preferred-project");
  });

  it("uses a configured project id for gemini-cli current-tier access", async () => {
    let capturedBody = "";
    let capturedUserAgent = "";

    globalThis.fetch = (async (_input, init) => {
      capturedBody = String(init?.body || "");
      capturedUserAgent = String(new Headers(init?.headers).get("User-Agent") || "");
      return new Response(
        JSON.stringify({
          currentTier: { id: "standard-tier" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const result = await ensureProjectContext(
      {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
      "gemini-cli",
      "configured-project",
      "gemini-3.1-pro-preview",
    );

    expect(result.projectId).toBe("configured-project");
    expect(result.auth.refresh).toBe("refresh-token|configured-project");
    expect(JSON.parse(capturedBody)).toEqual({
      cloudaicompanionProject: "configured-project",
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
        duetProject: "configured-project",
      },
    });
    expect(capturedUserAgent).toContain("/gemini-3.1-pro-preview ");
  });

  it("re-resolves gemini-cli project context after a configured project is cleared", async () => {
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({
          cloudaicompanionProject: { id: "managed-project-999" },
          allowedTiers: [{ id: "free-tier", isDefault: true }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const result = await ensureProjectContext(
      {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token|configured-project|managed-project-123",
        expires: Date.now() + 60_000,
      },
      "gemini-cli",
    );

    expect(callCount).toBe(1);
    expect(result.projectId).toBe("managed-project-999");
    expect(result.auth.refresh).toBe("refresh-token||managed-project-999");
  });

  it("clears stale managed gemini-cli project ids when a configured project is active", async () => {
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({
          currentTier: { id: "standard-tier" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const configured = await ensureProjectContext(
      {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token||managed-project-123",
        expires: Date.now() + 60_000,
      },
      "gemini-cli",
      "configured-project",
    );

    expect(callCount).toBe(1);
    expect(configured.projectId).toBe("configured-project");
    expect(configured.auth.refresh).toBe("refresh-token|configured-project");
  });

  it("replaces stale packed gemini-cli configured project ids", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          currentTier: { id: "standard-tier" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;

    const configured = await ensureProjectContext(
      {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token|old-configured-project",
        expires: Date.now() + 60_000,
      },
      "gemini-cli",
      "new-configured-project",
    );

    expect(configured.projectId).toBe("new-configured-project");
    expect(configured.auth.refresh).toBe("refresh-token|new-configured-project");
  });
});
