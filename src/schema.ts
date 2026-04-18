import {
  EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
  EMPTY_SCHEMA_PLACEHOLDER_NAME,
} from "./constants.ts";

type JsonRecord = Record<string, unknown>;

const UNSUPPORTED_CONSTRAINTS = [
  "minLength",
  "maxLength",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "minItems",
  "maxItems",
  "format",
  "default",
  "examples",
] as const;

const UNSUPPORTED_KEYS = new Set([
  ...UNSUPPORTED_CONSTRAINTS,
  "$schema",
  "$defs",
  "definitions",
  "$id",
  "$comment",
  "$ref",
  "const",
  "allOf",
  "anyOf",
  "oneOf",
  "additionalProperties",
  "propertyNames",
  "title",
]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function appendHint(schema: JsonRecord, hint: string): JsonRecord {
  const description = typeof schema.description === "string" ? schema.description : "";
  if (description.includes(hint)) return schema;
  return { ...schema, description: description ? `${description} (${hint})` : hint };
}

function normalizeEnumValues(type: unknown, values: unknown[]): unknown[] {
  if (type === "string") {
    return values.map((value) => String(value));
  }

  if (type === "integer" || type === "number") {
    return values
      .map((value) => (typeof value === "number" ? value : Number(value)))
      .filter((value) => !Number.isNaN(value));
  }

  if (type === "boolean") {
    return values.map((value) => {
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return Boolean(value);
    });
  }

  return values;
}

function resolveLocalRef(ref: string, root: unknown): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return null;

  let current: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!isRecord(current)) return null;
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    current = current[key];
  }
  return current;
}

function scoreOption(schema: JsonRecord): number {
  if (schema.type === "object" || isRecord(schema.properties)) return 3;
  if (schema.type === "array" || schema.items !== undefined) return 2;
  if (typeof schema.type === "string" && schema.type !== "null") return 1;
  return 0;
}

function mergeObjectSchemas(
  options: JsonRecord[],
  root: unknown,
  seenRefs: Set<string>,
): JsonRecord {
  const merged: JsonRecord = {};
  const required = new Set<string>();

  for (const option of options) {
    const cleaned = cleanSchema(option, root, seenRefs);
    if (!isRecord(cleaned)) continue;
    if (isRecord(cleaned.properties)) {
      merged.properties = {
        ...(merged.properties as JsonRecord | undefined),
        ...cleaned.properties,
      };
    }
    if (Array.isArray(cleaned.required)) {
      for (const field of cleaned.required) {
        if (typeof field === "string") required.add(field);
      }
    }
    for (const [key, value] of Object.entries(cleaned)) {
      if (key === "properties" || key === "required") continue;
      if (merged[key] === undefined) merged[key] = value;
    }
  }

  if (required.size > 0) merged.required = [...required];
  return merged;
}

function normalizeUnion(schema: JsonRecord, root: unknown, seenRefs: Set<string>): JsonRecord {
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (!union) return schema;

  const options = union.filter(isRecord);
  const enumValues = options.flatMap((option) => {
    if (option.const !== undefined) return [String(option.const)];
    if (Array.isArray(option.enum)) return option.enum.map((item) => String(item));
    return [];
  });

  if (enumValues.length === options.length && enumValues.length > 0) {
    return appendHint(
      { ...schema, enum: [...new Set(enumValues)] },
      `Allowed: ${[...new Set(enumValues)].join(", ")}`,
    );
  }

  const best = [...options].sort((left, right) => scoreOption(right) - scoreOption(left))[0];
  if (!best) return schema;
  const cleaned = cleanSchema(best, root, seenRefs);
  return isRecord(cleaned) ? { ...schema, ...cleaned } : schema;
}

function cleanSchema(schema: unknown, root: unknown, parentSeenRefs: Set<string>): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => cleanSchema(item, root, parentSeenRefs));
  }

  if (!isRecord(schema)) {
    return schema;
  }

  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    const target = resolveLocalRef(ref, root);
    if (target !== null && !parentSeenRefs.has(ref)) {
      const seenRefs = new Set(parentSeenRefs);
      seenRefs.add(ref);
      const rest = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$ref"));
      if (isRecord(target)) {
        const targetRecord = Object.fromEntries(
          Object.entries(target).filter(([key]) => key !== "$ref"),
        );
        return cleanSchema({ ...targetRecord, ...rest }, root, seenRefs);
      }
      return cleanSchema(target, root, seenRefs);
    }

    const targetName = ref.split("/").pop() || ref;
    return { type: "object", description: `See: ${targetName}` };
  }

  let normalized: JsonRecord = { ...schema };

  if (normalized.const !== undefined && !Array.isArray(normalized.enum)) {
    normalized.enum = [normalized.const];
  }

  if (Array.isArray(normalized.allOf)) {
    normalized = {
      ...normalized,
      ...mergeObjectSchemas(normalized.allOf.filter(isRecord), root, parentSeenRefs),
    };
  }

  normalized = normalizeUnion(normalized, root, parentSeenRefs);

  if (Array.isArray(normalized.type)) {
    const filtered = normalized.type.filter(
      (item): item is string => typeof item === "string" && item !== "null",
    );
    normalized.type = filtered[0] ?? "string";
  }

  let result: JsonRecord = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;
    if (key === "properties" && isRecord(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertyValue]) => [
          propertyName,
          cleanSchema(propertyValue, root, parentSeenRefs),
        ]),
      );
      continue;
    }
    result[key] = cleanSchema(value, root, parentSeenRefs);
  }

  for (const key of UNSUPPORTED_CONSTRAINTS) {
    if (normalized[key] !== undefined && typeof normalized[key] !== "object") {
      result = appendHint(result, `${key}: ${String(normalized[key])}`);
    }
  }

  if (normalized.additionalProperties === false) {
    result = appendHint(result, "No extra properties allowed");
  }

  if (Array.isArray(result.enum) && result.enum.length > 1) {
    const normalizedEnum = normalizeEnumValues(result.type, result.enum);
    result.enum = normalizedEnum;
    result = appendHint(result, `Allowed: ${normalizedEnum.map(String).join(", ")}`);
  } else if (Array.isArray(result.enum) && result.enum.length === 1) {
    result.enum = normalizeEnumValues(result.type, result.enum);
  }

  if (isRecord(result.properties)) {
    const properties = result.properties as JsonRecord;
    result.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        cleanSchema(value, root, parentSeenRefs),
      ]),
    );

    const required = result.required;
    if (Array.isArray(required)) {
      result.required = required.filter(
        (item): item is string => typeof item === "string" && Object.hasOwn(properties, item),
      );
      if (Array.isArray(result.required) && result.required.length === 0) delete result.required;
    }

    if (result.type === "object" && Object.keys(properties).length === 0) {
      result.properties = {
        [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
          type: "boolean",
          description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
        },
      };
      result.required = [EMPTY_SCHEMA_PLACEHOLDER_NAME];
    }
  }

  return result;
}

export function cleanJsonSchemaForAntigravity(schema: unknown): unknown {
  return cleanSchema(schema, schema, new Set());
}
