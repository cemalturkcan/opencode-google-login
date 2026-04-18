import { describe, expect, it } from "bun:test";
import {
  buildAntigravityRequest,
  createResponseUnwrapStream,
  unwrapAntigravityJson,
} from "../src/transforms.ts";

describe("buildAntigravityRequest", () => {
  it("wraps a Gemini request for Antigravity", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "secret",
          "x-goog-api-key": "secret-two",
          "x-goog-api-client": "should-be-removed",
          "client-metadata": "should-be-removed",
          "x-antigravity-model-id": "gemini-2.5-pro",
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const headers = result.init.headers as Headers;
    const body = JSON.parse(String(result.init.body));

    expect(result.request).toBe("https://cloudcode-pa.googleapis.com/v1internal:generateContent");
    expect(headers.get("Authorization")).toBe("Bearer access-token");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBeNull();
    expect(headers.get("x-goog-api-client")).toBeNull();
    expect(headers.get("client-metadata")).toBeNull();
    expect(headers.get("x-antigravity-model-id")).toBeNull();
    expect(body.project).toBe("project-123");
    expect(body.model).toBe("gemini-2.5-pro");
    expect(body.request.contents[0].parts[0].text).toBe("hi");
  });

  it("prefers the hinted Antigravity model id over the template url model", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-antigravity-model-id": "google-custom-claude-opus-4-6-thinking",
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    const headers = result.init.headers as Headers;

    expect(body.model).toBe("claude-opus-4-6-thinking");
    expect(body.request.generationConfig.thinkingConfig.thinking_budget).toBe(32768);
    expect(headers.get("x-antigravity-model-id")).toBeNull();
  });

  it("maps Google custom Opus requests to Claude backend model", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-claude-opus-4-6-thinking:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    expect(body.model).toBe("claude-opus-4-6-thinking");
    expect(body.request.generationConfig.thinkingConfig.thinking_budget).toBe(32768);
    expect(body.request.toolConfig.functionCallingConfig.mode).toBe("VALIDATED");
  });

  it("maps Google custom Gemini 3 Pro requests to backend model and thinking level", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-gemini-3-pro:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    expect(body.model).toBe("gemini-3-pro-low");
    expect(body.request.generationConfig.thinkingConfig.thinkingLevel).toBe("low");
  });

  it("preserves explicit user thinking config", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-gemini-3-pro:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { thinkingConfig: { includeThoughts: false, thinkingLevel: "high" } },
        }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    expect(body.request.generationConfig.thinkingConfig.includeThoughts).toBe(false);
    expect(body.request.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });

  it("uses the effective Gemini CLI model in the user agent", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-gemini-3.1-pro:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": "secret-two",
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
      "gemini-cli",
    );

    const headers = result.init.headers as Headers;

    expect(headers.get("User-Agent")).toContain("/gemini-3.1-pro-preview ");
    expect(headers.get("x-goog-api-key")).toBeNull();
  });

  it("preserves explicit Claude thinking config", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-claude-opus-4-6-thinking:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { thinkingConfig: { include_thoughts: false, thinking_budget: 8192 } },
        }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    expect(body.request.generationConfig.thinkingConfig.include_thoughts).toBe(false);
    expect(body.request.generationConfig.thinkingConfig.thinking_budget).toBe(8192);
  });

  it("normalizes camelCase Claude thinking config into snake_case only", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-claude-opus-4-6-thinking:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { thinkingConfig: { includeThoughts: false, thinkingBudget: 8192 } },
        }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    expect(body.request.generationConfig.thinkingConfig.include_thoughts).toBe(false);
    expect(body.request.generationConfig.thinkingConfig.thinking_budget).toBe(8192);
    expect(body.request.generationConfig.thinkingConfig.includeThoughts).toBeUndefined();
    expect(body.request.generationConfig.thinkingConfig.thinkingBudget).toBeUndefined();
  });

  it("normalizes camelCase Claude config even without a default thinking budget", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-claude-sonnet-4-6:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { thinkingConfig: { includeThoughts: false, thinkingBudget: 4096 } },
        }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.request.generationConfig.thinkingConfig.include_thoughts).toBe(false);
    expect(body.request.generationConfig.thinkingConfig.thinking_budget).toBe(4096);
    expect(body.request.generationConfig.thinkingConfig.includeThoughts).toBeUndefined();
    expect(body.request.generationConfig.thinkingConfig.thinkingBudget).toBeUndefined();
  });

  it("normalizes Claude tools into functionDeclarations with placeholder schema", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-claude-sonnet-4-6:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          tools: [{ custom: { name: "Bash Tool", description: "Runs bash" } }],
        }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    const declaration = body.request.tools[0].functionDeclarations[0];

    expect(declaration.name).toBe("Bash_Tool");
    expect(declaration.parameters.type).toBe("object");
    expect(declaration.parameters.properties._placeholder.type).toBe("boolean");
    expect(declaration.parameters.required).toEqual(["_placeholder"]);
  });

  it("strips unsigned prior Claude thinking parts when no tool use exists", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-claude-opus-4-6-thinking:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: "selam" }] },
            {
              role: "model",
              parts: [{ type: "reasoning", text: "Thinking text" }, { text: "Selam!" }],
            },
            { role: "user", parts: [{ text: "devam" }] },
          ],
        }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    expect(body.request.contents[1].parts).toEqual([{ text: "Selam!" }]);
  });

  it("strips unsigned Claude thinking even on tool-use turns", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-claude-opus-4-6-thinking:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: "selam" }] },
            {
              role: "model",
              parts: [
                { type: "reasoning", text: "Thinking text" },
                { functionCall: { name: "Read", args: {} } },
              ],
            },
          ],
        }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    expect(body.request.contents[1].parts).toEqual([
      { functionCall: { name: "Read", args: {}, id: "tool-call-1" } },
    ]);
  });

  it("uses providerMetadata signature for Claude messages", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-claude-opus-4-6-thinking:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "reasoning",
                  text: "Thinking text",
                  providerMetadata: { anthropic: { signature: "sig-123" } },
                },
                { type: "text", text: "Selam!" },
              ],
            },
          ],
        }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    expect(body.request.messages[0].content[0]).toEqual({
      type: "thinking",
      thinking: "Thinking text",
      signature: "sig-123",
    });
  });

  it("assigns ids to Claude functionCall parts in contents", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-claude-opus-4-6-thinking:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: "incele" }] },
            {
              role: "model",
              parts: [{ functionCall: { name: "Read", args: { filePath: "/tmp/a" } } }],
            },
          ],
        }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    expect(body.request.contents[1].parts[0].functionCall.id).toBe("tool-call-1");
  });

  it("matches missing functionResponse ids to prior Claude functionCall ids", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-claude-opus-4-6-thinking:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "model",
              parts: [{ functionCall: { name: "Read", args: { filePath: "/tmp/a" } } }],
            },
            {
              role: "user",
              parts: [{ functionResponse: { name: "Read", response: { result: "ok" } } }],
            },
          ],
        }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    expect(body.request.contents[0].parts[0].functionCall.id).toBe("tool-call-1");
    expect(body.request.contents[1].parts[0].functionResponse.id).toBe("tool-call-1");
  });

  it("injects strict parameter signatures into tool descriptions", async () => {
    const result = await buildAntigravityRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/google-custom-gemini-3.1-pro:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: "Glob",
                  description: "Find files by pattern",
                  parameters: {
                    type: "object",
                    properties: {
                      pattern: { type: "string" },
                      path: { type: "string" },
                    },
                    required: ["pattern"],
                  },
                },
              ],
            },
          ],
        }),
      },
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    const body = JSON.parse(String(result.init.body));
    expect(body.request.tools[0].functionDeclarations[0].description).toContain(
      "STRICT PARAMETERS: pattern (string, REQUIRED), path (string).",
    );
  });

  it("preserves Request method when init is omitted", async () => {
    const request = new Request(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      },
    );

    const result = await buildAntigravityRequest(
      request,
      undefined,
      "access-token",
      "project-123",
      "https://cloudcode-pa.googleapis.com",
    );

    expect(result.init.method).toBe("POST");
  });
});

describe("unwrapAntigravityJson", () => {
  it("unwraps the response envelope", () => {
    expect(unwrapAntigravityJson('{"response":{"candidates":[{"content":{"parts":[]}}]}}')).toBe(
      '{"candidates":[{"content":{"parts":[]}}]}',
    );
  });
});

describe("createResponseUnwrapStream", () => {
  it("unwraps streamed SSE payloads", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"response":{"candidates":[{"content":{"parts":[]}}]}}\n\n'),
        );
        controller.close();
      },
    });

    const transformed = createResponseUnwrapStream(stream.getReader());
    const reader = transformed.getReader();
    const decoder = new TextDecoder();
    let output = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();

    expect(output).toBe('data: {"candidates":[{"content":{"parts":[]}}]}\n\n');
  });
});
