import { randomUUID } from "node:crypto";
import {
  EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
  EMPTY_SCHEMA_PLACEHOLDER_NAME,
  getAntigravityHeaders,
} from "./constants.ts";
import { buildGeminiCliUserAgent, createGeminiCliActivityRequestId } from "./gemini-cli.ts";
import { log } from "./logger.ts";
import { resolveAntigravityModel } from "./models.ts";
import { cleanJsonSchemaForAntigravity } from "./schema.ts";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureGeminiCliRequestIdentifiers(request: JsonRecord): void {
  if (typeof request.session_id !== "string" || request.session_id.length === 0) {
    request.session_id = randomUUID();
  }
}

function rewriteDataLine(line: string): string {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return line;

  try {
    const parsed = parseAntigravityBody(payload);
    return parsed?.response ? `data: ${JSON.stringify(parsed.response)}` : line;
  } catch {
    return line;
  }
}

function sanitizeTools(payload: JsonRecord): void {
  if (!Array.isArray(payload.tools)) return;
  payload.tools = payload.tools.map((tool) => {
    if (!isRecord(tool)) return tool;
    if (!Array.isArray(tool.functionDeclarations)) return tool;

    return {
      ...tool,
      functionDeclarations: tool.functionDeclarations.map((declaration) => {
        if (!isRecord(declaration) || !declaration.parameters) return declaration;
        return {
          ...declaration,
          parameters: cleanJsonSchemaForAntigravity(declaration.parameters),
        };
      }),
    };
  });
}

function normalizeToolSchema(schema: unknown): Record<string, unknown> {
  const placeholder = {
    type: "object",
    properties: {
      [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
        type: "boolean",
        description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
      },
    },
    required: [EMPTY_SCHEMA_PLACEHOLDER_NAME],
  } as const;

  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { ...placeholder };
  }

  const cleaned = cleanJsonSchemaForAntigravity(schema);
  if (!isRecord(cleaned)) {
    return { ...placeholder };
  }

  const properties = isRecord(cleaned.properties) ? cleaned.properties : undefined;
  if (!properties || Object.keys(properties).length === 0) {
    return {
      ...cleaned,
      ...placeholder,
      required: Array.isArray(cleaned.required)
        ? [
            ...new Set([
              ...cleaned.required.filter((item): item is string => typeof item === "string"),
              EMPTY_SCHEMA_PLACEHOLDER_NAME,
            ]),
          ]
        : [EMPTY_SCHEMA_PLACEHOLDER_NAME],
    };
  }

  return { ...cleaned, type: "object" };
}

function normalizeClaudeTools(payload: JsonRecord): void {
  if (!Array.isArray(payload.tools)) return;

  const functionDeclarations: Array<Record<string, unknown>> = [];
  const passthroughTools: unknown[] = [];

  const pushDeclaration = (tool: JsonRecord, declaration?: JsonRecord): void => {
    const source = declaration ?? tool;
    const toolFunction = isRecord(tool.function) ? tool.function : undefined;
    const toolCustom = isRecord(tool.custom) ? tool.custom : undefined;
    const schema =
      source.parameters ??
      source.parametersJsonSchema ??
      source.input_schema ??
      source.inputSchema ??
      tool.parameters ??
      tool.parametersJsonSchema ??
      tool.input_schema ??
      tool.inputSchema ??
      toolFunction?.parameters ??
      toolFunction?.parametersJsonSchema ??
      toolFunction?.input_schema ??
      toolFunction?.inputSchema ??
      toolCustom?.parameters ??
      toolCustom?.parametersJsonSchema ??
      toolCustom?.input_schema ??
      toolCustom?.inputSchema;

    const name = String(
      source.name ??
        tool.name ??
        toolFunction?.name ??
        toolCustom?.name ??
        `tool-${functionDeclarations.length}`,
    )
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 64);

    const description = String(
      source.description ??
        tool.description ??
        toolFunction?.description ??
        toolCustom?.description ??
        "",
    );

    functionDeclarations.push({
      name,
      description,
      parameters: normalizeToolSchema(schema),
    });
  };

  for (const tool of payload.tools) {
    if (!isRecord(tool)) {
      passthroughTools.push(tool);
      continue;
    }

    if (Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0) {
      for (const declaration of tool.functionDeclarations) {
        if (isRecord(declaration)) {
          pushDeclaration(tool, declaration);
        }
      }
      continue;
    }

    if (
      isRecord(tool.function) ||
      isRecord(tool.custom) ||
      tool.parameters !== undefined ||
      tool.parametersJsonSchema !== undefined ||
      tool.input_schema !== undefined ||
      tool.inputSchema !== undefined
    ) {
      pushDeclaration(tool);
      continue;
    }

    passthroughTools.push(tool);
  }

  payload.tools = [
    ...(functionDeclarations.length > 0 ? [{ functionDeclarations }] : []),
    ...passthroughTools,
  ];
}

function getThinkingText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.thinking === "string") return value.thinking;
  }
  return undefined;
}

function getThinkingSignature(part: JsonRecord): string | undefined {
  if (typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0) {
    return part.thoughtSignature;
  }
  if (typeof part.thought_signature === "string" && part.thought_signature.length > 0) {
    return part.thought_signature;
  }
  if (typeof part.signature === "string" && part.signature.length > 0) {
    return part.signature;
  }
  const providerMetadata = isRecord(part.providerMetadata) ? part.providerMetadata : undefined;
  const anthropic =
    providerMetadata && isRecord(providerMetadata.anthropic)
      ? providerMetadata.anthropic
      : undefined;
  return typeof anthropic?.signature === "string" && anthropic.signature.length > 0
    ? anthropic.signature
    : undefined;
}

function normalizeClaudeContents(payload: JsonRecord): void {
  if (!Array.isArray(payload.contents)) return;

  payload.contents = payload.contents.map((content) => {
    if (!isRecord(content) || !Array.isArray(content.parts)) {
      return content;
    }

    if (content.role !== "model" && content.role !== "assistant") {
      return content;
    }

    return {
      ...content,
      parts: content.parts.flatMap((part) => {
        if (!isRecord(part)) return part;

        const isThinking =
          part.thought === true ||
          part.type === "thinking" ||
          part.type === "redacted_thinking" ||
          part.type === "reasoning";

        if (!isThinking) return part;

        const text = getThinkingText(part.text) ?? getThinkingText(part.thinking) ?? "";
        const signature = getThinkingSignature(part);

        if (!signature) {
          return [];
        }

        return {
          thought: true,
          ...(text ? { text } : {}),
          thoughtSignature: signature,
        };
      }),
    };
  });
}

function normalizeClaudeMessages(payload: JsonRecord): void {
  if (!Array.isArray(payload.messages)) return;

  payload.messages = payload.messages.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.content) || message.role !== "assistant") {
      return message;
    }

    return {
      ...message,
      content: message.content.flatMap((block) => {
        if (!isRecord(block)) return block;

        const isThinking =
          block.thought === true ||
          block.type === "thinking" ||
          block.type === "redacted_thinking" ||
          block.type === "reasoning";

        if (!isThinking) return block;

        const text = getThinkingText(block.thinking) ?? getThinkingText(block.text) ?? "";
        const signature = getThinkingSignature(block);

        if (!signature) {
          return [];
        }

        return {
          type: block.type === "redacted_thinking" ? "redacted_thinking" : "thinking",
          ...(text ? { thinking: text } : {}),
          signature,
        };
      }),
    };
  });
}

function normalizeClaudeThinking(payload: JsonRecord): void {
  normalizeClaudeContents(payload);
  normalizeClaudeMessages(payload);
}

function normalizeClaudeToolPairs(payload: JsonRecord): void {
  if (Array.isArray(payload.contents)) {
    let toolCallCounter = 0;
    const pendingToolIdsByName = new Map<string, string[]>();

    payload.contents = payload.contents.map((content) => {
      if (!isRecord(content) || !Array.isArray(content.parts)) {
        return content;
      }

      return {
        ...content,
        parts: content.parts.map((part) => {
          if (!isRecord(part)) return part;

          if (isRecord(part.functionCall)) {
            const call = { ...part.functionCall };
            if (typeof call.id !== "string" || call.id.length === 0) {
              call.id = `tool-call-${++toolCallCounter}`;
            }
            const callId = String(call.id);
            const name = typeof call.name === "string" ? call.name : "unknown_function";
            const queue = pendingToolIdsByName.get(name) || [];
            queue.push(callId);
            pendingToolIdsByName.set(name, queue);
            return { ...part, functionCall: { ...call, id: callId } };
          }

          if (isRecord(part.functionResponse)) {
            const response = { ...part.functionResponse };
            if (
              (typeof response.id !== "string" || response.id.length === 0) &&
              typeof response.name === "string"
            ) {
              const queue = pendingToolIdsByName.get(response.name);
              if (queue && queue.length > 0) {
                response.id = queue.shift();
                pendingToolIdsByName.set(response.name, queue);
              }
            }
            return { ...part, functionResponse: response };
          }

          return part;
        }),
      };
    });
  }
}

function injectToolParameterSignatures(payload: JsonRecord): void {
  if (!Array.isArray(payload.tools)) return;

  payload.tools = payload.tools.map((tool) => {
    if (!isRecord(tool) || !Array.isArray(tool.functionDeclarations)) {
      return tool;
    }

    return {
      ...tool,
      functionDeclarations: tool.functionDeclarations.map((declaration) => {
        if (!isRecord(declaration)) return declaration;

        const parameters = isRecord(declaration.parameters)
          ? declaration.parameters
          : isRecord(declaration.parametersJsonSchema)
            ? declaration.parametersJsonSchema
            : undefined;

        if (!parameters || !isRecord(parameters.properties)) {
          return declaration;
        }

        const properties = parameters.properties;
        const required = Array.isArray(parameters.required)
          ? parameters.required.filter((item): item is string => typeof item === "string")
          : [];

        const parts = Object.entries(properties).map(([name, value]) => {
          const record = isRecord(value) ? value : {};
          const type = typeof record.type === "string" ? record.type : "unknown";
          return `${name} (${type}${required.includes(name) ? ", REQUIRED" : ""})`;
        });

        if (parts.length === 0) return declaration;

        const description =
          typeof declaration.description === "string" ? declaration.description : "";
        if (description.includes("STRICT PARAMETERS:")) {
          return declaration;
        }

        return {
          ...declaration,
          description: `${description}\n\nSTRICT PARAMETERS: ${parts.join(", ")}.`.trim(),
        };
      }),
    };
  });
}

function ensureObjectRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function omitKeys(record: JsonRecord, keys: string[]): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

function getIncludeThoughtsDefault(current: JsonRecord, snakeCase = false): boolean {
  const primary = snakeCase ? current.include_thoughts : current.includeThoughts;
  const alternate = snakeCase ? current.includeThoughts : current.include_thoughts;
  if (typeof primary === "boolean") return primary;
  if (typeof alternate === "boolean") return alternate;
  return true;
}

function applyClaudeOptions(payload: JsonRecord, thinkingBudget?: number): void {
  payload.toolConfig = ensureObjectRecord(payload.toolConfig);
  const toolConfig = payload.toolConfig as JsonRecord;
  toolConfig.functionCallingConfig = ensureObjectRecord(toolConfig.functionCallingConfig);
  (toolConfig.functionCallingConfig as JsonRecord).mode = "VALIDATED";

  const generationConfig = ensureObjectRecord(payload.generationConfig);
  const currentThinkingConfig = ensureObjectRecord(generationConfig.thinkingConfig);
  const normalizedThinkingConfig = omitKeys(currentThinkingConfig, [
    "includeThoughts",
    "thinkingBudget",
    "thinkingLevel",
  ]);
  const currentThinkingBudget =
    typeof currentThinkingConfig.thinking_budget === "number"
      ? currentThinkingConfig.thinking_budget
      : typeof currentThinkingConfig.thinkingBudget === "number"
        ? currentThinkingConfig.thinkingBudget
        : undefined;

  if (Object.keys(currentThinkingConfig).length > 0 || typeof currentThinkingBudget === "number") {
    generationConfig.thinkingConfig = {
      ...normalizedThinkingConfig,
      include_thoughts: getIncludeThoughtsDefault(currentThinkingConfig, true),
      ...(typeof currentThinkingBudget === "number"
        ? { thinking_budget: currentThinkingBudget }
        : {}),
    };
  }

  if (typeof thinkingBudget !== "number" || thinkingBudget <= 0) {
    payload.generationConfig = generationConfig;
    return;
  }

  generationConfig.thinkingConfig = {
    ...ensureObjectRecord(generationConfig.thinkingConfig),
    include_thoughts: getIncludeThoughtsDefault(currentThinkingConfig, true),
    ...(typeof currentThinkingBudget === "number"
      ? { thinking_budget: currentThinkingBudget }
      : { thinking_budget: thinkingBudget }),
  };

  const maxOutputTokens =
    typeof generationConfig.maxOutputTokens === "number"
      ? generationConfig.maxOutputTokens
      : typeof generationConfig.max_output_tokens === "number"
        ? generationConfig.max_output_tokens
        : undefined;

  if (!maxOutputTokens || maxOutputTokens <= thinkingBudget) {
    generationConfig.maxOutputTokens = 64000;
    delete generationConfig.max_output_tokens;
  }

  payload.generationConfig = generationConfig;
}

function applyGeminiOptions(
  payload: JsonRecord,
  thinkingLevel?: "minimal" | "low" | "medium" | "high",
  thinkingBudget?: number,
): void {
  if (!thinkingLevel && typeof thinkingBudget !== "number") {
    return;
  }

  const generationConfig = ensureObjectRecord(payload.generationConfig);
  const currentThinkingConfig = ensureObjectRecord(generationConfig.thinkingConfig);
  const normalizedThinkingConfig = omitKeys(currentThinkingConfig, [
    "include_thoughts",
    "thinking_budget",
  ]);
  generationConfig.thinkingConfig = {
    ...normalizedThinkingConfig,
    includeThoughts: getIncludeThoughtsDefault(currentThinkingConfig),
    ...(thinkingLevel && currentThinkingConfig.thinkingLevel === undefined
      ? { thinkingLevel }
      : {}),
    ...(typeof thinkingBudget === "number" &&
    thinkingBudget > 0 &&
    currentThinkingConfig.thinkingBudget === undefined
      ? { thinkingBudget }
      : {}),
  };
  payload.generationConfig = generationConfig;
}

function parseAntigravityBody(rawText: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      const first = parsed.find((item) => isRecord(item));
      return isRecord(first) ? first : null;
    }
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function transformChunk(chunk: string): string {
  return chunk
    .split("\n\n")
    .map((event) => event.split("\n").map(rewriteDataLine).join("\n"))
    .join("\n\n");
}

export function isGenerativeLanguageRequest(input: RequestInfo | URL): boolean {
  const url = input instanceof Request ? input.url : input.toString();
  return url.includes("generativelanguage.googleapis.com");
}

export async function buildAntigravityRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
  endpoint: string,
  backend: "antigravity" | "gemini-cli" = "antigravity",
): Promise<{
  request: string;
  init: RequestInit;
  streaming: boolean;
}> {
  const baseInit: RequestInit =
    input instanceof Request
      ? {
          method: input.method,
          cache: input.cache,
          credentials: input.credentials,
          integrity: input.integrity,
          keepalive: input.keepalive,
          mode: input.mode,
          redirect: input.redirect,
          referrer: input.referrer,
          referrerPolicy: input.referrerPolicy,
          signal: input.signal,
        }
      : {};
  const originalUrl = new URL(input instanceof Request ? input.url : input.toString());
  const match = originalUrl.pathname.match(/\/models\/([^:]+):(\w+)/);
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  const hintedModelId = headers.get("x-antigravity-model-id") || undefined;
  const [, urlModelId, action = ""] = match || [];
  const requestedModelId = hintedModelId || urlModelId;
  const resolvedModel = resolveAntigravityModel(requestedModelId || "");
  const outboundModel =
    backend === "gemini-cli" && resolvedModel.cliModel
      ? resolvedModel.cliModel
      : resolvedModel.actualModel;

  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set(
    "User-Agent",
    backend === "gemini-cli"
      ? buildGeminiCliUserAgent(outboundModel || requestedModelId || undefined)
      : getAntigravityHeaders()["User-Agent"],
  );
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  headers.delete("x-goog-user-project");
  headers.delete("x-goog-api-client");
  headers.delete("client-metadata");
  headers.delete("x-antigravity-model-id");
  if (backend === "gemini-cli") {
    headers.set("x-activity-request-id", createGeminiCliActivityRequestId());
  }

  if (!match) {
    return {
      request: originalUrl.toString(),
      init: { ...baseInit, ...init, headers },
      streaming: false,
    };
  }

  const streaming = action === "streamGenerateContent";
  if (streaming) headers.set("Accept", "text/event-stream");

  let rawBody = typeof init?.body === "string" ? init.body : undefined;
  if (
    !rawBody &&
    input instanceof Request &&
    headers.get("content-type")?.includes("application/json")
  ) {
    try {
      rawBody = await input.clone().text();
    } catch {}
  }

  let body = rawBody;
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as JsonRecord;
      if (typeof parsed.project === "string" && isRecord(parsed.request)) {
        sanitizeTools(parsed.request);
        if (resolvedModel.isClaude) {
          normalizeClaudeThinking(parsed.request);
          normalizeClaudeToolPairs(parsed.request);
          normalizeClaudeTools(parsed.request);
        }
        injectToolParameterSignatures(parsed.request);
        if (backend === "gemini-cli") {
          ensureGeminiCliRequestIdentifiers(parsed.request);
        }
        parsed.project = projectId;
        if (resolvedModel.isClaude) {
          applyClaudeOptions(parsed.request, resolvedModel.thinkingBudget);
        } else {
          applyGeminiOptions(
            parsed.request,
            resolvedModel.thinkingLevel,
            resolvedModel.thinkingBudget,
          );
        }
        parsed.model = outboundModel;
        if (backend === "gemini-cli") {
          if (typeof parsed.user_prompt_id !== "string" || parsed.user_prompt_id.length === 0) {
            parsed.user_prompt_id = randomUUID();
          }
          delete parsed.requestType;
          delete parsed.userAgent;
          delete parsed.requestId;
        }
        body = JSON.stringify(parsed);
      } else {
        sanitizeTools(parsed);
        if (resolvedModel.isClaude) {
          normalizeClaudeThinking(parsed);
          normalizeClaudeToolPairs(parsed);
          normalizeClaudeTools(parsed);
        }
        injectToolParameterSignatures(parsed);
        if (backend === "gemini-cli") {
          ensureGeminiCliRequestIdentifiers(parsed);
        }
        if (resolvedModel.isClaude) {
          applyClaudeOptions(parsed, resolvedModel.thinkingBudget);
        } else {
          applyGeminiOptions(parsed, resolvedModel.thinkingLevel, resolvedModel.thinkingBudget);
        }
        body = JSON.stringify(
          backend === "gemini-cli"
            ? {
                project: projectId,
                model: outboundModel,
                user_prompt_id: randomUUID(),
                request: parsed,
              }
            : {
                project: projectId,
                model: outboundModel,
                request: parsed,
                requestType: "agent",
                userAgent: backend,
                requestId: `agent-${randomUUID()}`,
              },
        );
      }
    } catch (error) {
      log.warn("Failed to transform request body for Antigravity", { error: String(error) });
    }
  }

  return {
    request: `${endpoint}/v1internal:${action}${streaming ? "?alt=sse" : ""}`,
    init: {
      ...baseInit,
      ...init,
      headers,
      body,
    },
    streaming,
  };
}

export function unwrapAntigravityJson(rawText: string): string {
  const parsed = parseAntigravityBody(rawText);
  return parsed?.response ? JSON.stringify(parsed.response) : rawText;
}

export function createResponseUnwrapStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer) controller.enqueue(encoder.encode(transformChunk(buffer)));
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        const boundary = buffer.lastIndexOf("\n\n");
        if (boundary === -1) continue;

        const chunk = buffer.slice(0, boundary + 2);
        buffer = buffer.slice(boundary + 2);
        controller.enqueue(encoder.encode(transformChunk(chunk)));
        return;
      }
    },
  });
}
