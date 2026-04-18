import { describe, expect, it } from "bun:test";
import { createAuthorizationRequest, parseCallbackInput } from "../src/oauth.ts";

describe("createAuthorizationRequest", () => {
  it("embeds a PKCE challenge and state", () => {
    const result = createAuthorizationRequest("project-123");
    const url = new URL(result.url);

    expect(url.searchParams.get("client_id")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe(result.state);
  });
});

describe("parseCallbackInput", () => {
  it("parses a full callback URL", () => {
    expect(
      parseCallbackInput(
        "http://localhost:51121/oauth-callback?code=abc123&state=state456",
        "state456",
      ),
    ).toEqual({ code: "abc123", state: "state456" });
  });

  it("falls back to the original state when only a code is pasted", () => {
    expect(parseCallbackInput("abc123", "fallback-state")).toEqual({
      code: "abc123",
      state: "fallback-state",
    });
  });

  it("returns a structured error for oauth failures", () => {
    expect(parseCallbackInput("?error=access_denied", "fallback-state")).toEqual({
      error: "OAuth error: access_denied",
    });
  });

  it("rejects mismatched callback state", () => {
    expect(
      parseCallbackInput(
        "http://localhost:51121/oauth-callback?code=abc123&state=wrong",
        "expected",
      ),
    ).toEqual({ error: "OAuth state mismatch" });
  });

  it("rejects callback urls without state", () => {
    expect(
      parseCallbackInput("http://localhost:51121/oauth-callback?code=abc123", "expected"),
    ).toEqual({ error: "OAuth state mismatch" });
  });
});
