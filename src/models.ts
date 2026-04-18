type ProviderModel = {
  id: string;
  providerID: string;
  api: { id: string; url: string; npm: string };
  name: string;
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
  };
  cost: {
    input: number;
    output: number;
    cache: { read: number; write: number };
  };
  limit: { context: number; output: number };
  status: "alpha" | "beta" | "deprecated" | "active";
  options: Record<string, unknown>;
  headers: Record<string, string>;
};

type ProviderLike = {
  id: string;
  models: Record<string, ProviderModel>;
};

type ProviderConfigModel = {
  name: string;
  reasoning: boolean;
  attachment: boolean;
  temperature: boolean;
  tool_call: boolean;
  limit: { context: number; output: number };
  modalities: {
    input: Array<"text" | "audio" | "image" | "video" | "pdf">;
    output: Array<"text" | "audio" | "image" | "video" | "pdf">;
  };
  options: Record<string, unknown>;
  headers: Record<string, string>;
  provider: { npm: string };
};

export type AntigravityProviderConfig = {
  name: string;
  npm: string;
  env: string[];
  options: { apiKey: string; projectId: string };
  models: Record<string, ProviderConfigModel>;
};

export type ProviderModelVisibilityOptions = {
  includeModels?: boolean;
  includeClaude: boolean;
};

type ConfigProvidersResponse = {
  providers?: Array<{
    id?: string;
    models?: Record<string, ProviderModel>;
  }>;
};

type AntigravityModelSpec = {
  id: string;
  name: string;
  limit: { context: number; output: number };
  reasoning: boolean;
};

export type ResolvedAntigravityModel = {
  actualModel: string;
  cliModel?: string;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  thinkingBudget?: number;
  isClaude: boolean;
};

const ANTIGRAVITY_MODEL_SPECS: AntigravityModelSpec[] = [
  {
    id: "google-custom-gemini-3-pro",
    name: "Gemini 3 Pro (Google custom)",
    limit: { context: 1048576, output: 65535 },
    reasoning: true,
  },
  {
    id: "google-custom-gemini-3.1-pro",
    name: "Gemini 3.1 Pro (Google custom)",
    limit: { context: 1048576, output: 65535 },
    reasoning: true,
  },
  {
    id: "google-custom-gemini-3-flash",
    name: "Gemini 3 Flash (Google custom)",
    limit: { context: 1048576, output: 65536 },
    reasoning: true,
  },
  {
    id: "google-custom-claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Google custom)",
    limit: { context: 200000, output: 64000 },
    reasoning: false,
  },
  {
    id: "google-custom-claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 Thinking (Google custom)",
    limit: { context: 200000, output: 64000 },
    reasoning: true,
  },
] as const;

const ANTIGRAVITY_MODEL_IDS = new Set(ANTIGRAVITY_MODEL_SPECS.map((spec) => spec.id));

const MODEL_RESOLUTION: Record<string, ResolvedAntigravityModel> = {
  "google-custom-gemini-3-pro": {
    actualModel: "gemini-3-pro-low",
    cliModel: "gemini-3-pro-preview",
    thinkingLevel: "low",
    isClaude: false,
  },
  "google-custom-gemini-3.1-pro": {
    actualModel: "gemini-3.1-pro-low",
    cliModel: "gemini-3.1-pro-preview",
    thinkingLevel: "low",
    isClaude: false,
  },
  "google-custom-gemini-3-flash": {
    actualModel: "gemini-3-flash",
    cliModel: "gemini-3-flash-preview",
    thinkingLevel: "low",
    isClaude: false,
  },
  "google-custom-claude-sonnet-4-6": {
    actualModel: "claude-sonnet-4-6",
    isClaude: true,
  },
  "google-custom-claude-opus-4-6-thinking": {
    actualModel: "claude-opus-4-6-thinking",
    thinkingBudget: 32768,
    isClaude: true,
  },
};

function cloneFromTemplate(
  template: ProviderModel,
  providerID: string,
  spec: AntigravityModelSpec,
): ProviderModel {
  return {
    ...template,
    id: spec.id,
    providerID,
    name: spec.name,
    limit: spec.limit,
    status: "active",
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    capabilities: {
      ...template.capabilities,
      reasoning: spec.reasoning,
      attachment: true,
      toolcall: true,
      input: {
        ...template.capabilities.input,
        text: true,
        image: true,
        pdf: true,
      },
      output: {
        ...template.capabilities.output,
        text: true,
      },
    },
    options: { ...template.options, antigravity: true },
    headers: { ...template.headers },
  };
}

let cachedGoogleTemplateModels: Record<string, ProviderModel> | null = null;

function pickTemplate(
  provider: ProviderLike,
  modelID: string,
  templateModels: Record<string, ProviderModel>,
): ProviderModel | undefined {
  const explicitCandidates: Record<string, string[]> = {
    "google-custom-gemini-3-pro": [
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
    ],
    "google-custom-gemini-3.1-pro": [
      "gemini-3.1-pro-preview-customtools",
      "gemini-3.1-pro-preview",
      "gemini-3-pro-preview",
    ],
    "google-custom-gemini-3-flash": [
      "gemini-3-flash-preview",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
    ],
    "google-custom-claude-sonnet-4-6": ["gemini-3-flash-preview", "gemini-2.5-pro"],
    "google-custom-claude-opus-4-6-thinking": [
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-2.5-pro",
    ],
  };

  for (const candidate of explicitCandidates[modelID] || []) {
    if (templateModels[candidate]) return templateModels[candidate];
  }

  return Object.values(templateModels)[0];
}

async function loadGoogleTemplateModels(serverUrl: URL): Promise<Record<string, ProviderModel>> {
  if (cachedGoogleTemplateModels) {
    return cachedGoogleTemplateModels;
  }

  const response = await fetch(new URL("/config/providers", serverUrl));
  if (!response.ok) {
    throw new Error(`Failed to load provider templates: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as ConfigProvidersResponse;
  const googleProvider = payload.providers?.find((provider) => provider.id === "google");
  cachedGoogleTemplateModels = googleProvider?.models || {};
  return cachedGoogleTemplateModels;
}

export async function registerAntigravityModels(
  provider: ProviderLike,
  serverUrl: URL,
  options: ProviderModelVisibilityOptions = { includeClaude: true },
): Promise<void> {
  provider.models ??= {};

  const baseModels = Object.fromEntries(
    Object.entries(provider.models).filter(([id]) => !ANTIGRAVITY_MODEL_IDS.has(id)),
  );
  provider.models = { ...baseModels };

  if (options.includeModels === false) {
    return;
  }

  const templateModels =
    Object.keys(baseModels).length > 0 ? baseModels : await loadGoogleTemplateModels(serverUrl);

  for (const spec of filterModelSpecs(options)) {
    const template = pickTemplate(provider, spec.id, templateModels);
    if (!template) continue;
    provider.models[spec.id] = cloneFromTemplate(template, provider.id, spec);
  }
}

export function resolveAntigravityModel(modelID: string): ResolvedAntigravityModel {
  return (
    MODEL_RESOLUTION[modelID] || {
      actualModel: modelID.replace(/^google-custom-/, ""),
      isClaude: modelID.includes("claude"),
    }
  );
}

export const __testExports = {
  ANTIGRAVITY_MODEL_SPECS,
  ANTIGRAVITY_MODEL_IDS,
};

function filterModelSpecs(options: ProviderModelVisibilityOptions): AntigravityModelSpec[] {
  if (options.includeModels === false) {
    return [];
  }

  return ANTIGRAVITY_MODEL_SPECS.filter(
    (spec) => options.includeClaude || !spec.id.includes("claude"),
  );
}

export function buildAntigravityProviderConfig(
  options: ProviderModelVisibilityOptions = { includeClaude: true },
): AntigravityProviderConfig {
  const inputModalities: ProviderConfigModel["modalities"]["input"] = ["text", "image", "pdf"];
  const outputModalities: ProviderConfigModel["modalities"]["output"] = ["text"];

  const models: Record<string, ProviderConfigModel> = Object.fromEntries(
    filterModelSpecs(options).map((spec) => [
      spec.id,
      {
        name: spec.name,
        reasoning: spec.reasoning,
        attachment: true,
        temperature: true,
        tool_call: true,
        limit: spec.limit,
        modalities: {
          input: inputModalities,
          output: outputModalities,
        },
        options: { antigravity: true },
        headers: {},
        provider: { npm: "@ai-sdk/google" },
      },
    ]),
  );

  return {
    name: "Google (custom)",
    npm: "@ai-sdk/google",
    env: [],
    options: { apiKey: "", projectId: "" },
    models,
  };
}
