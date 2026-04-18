import { describe, expect, it } from "bun:test";
import { cleanJsonSchemaForAntigravity } from "../src/schema.ts";

describe("cleanJsonSchemaForAntigravity", () => {
  it("preserves local scalar refs", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { $ref: "#/$defs/mode" },
      },
      required: ["mode"],
      $defs: {
        mode: {
          type: "string",
          enum: ["fast", "slow"],
        },
      },
    };

    expect(cleanJsonSchemaForAntigravity(schema)).toEqual({
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["fast", "slow"],
          description: "Allowed: fast, slow",
        },
      },
      required: ["mode"],
    });
  });

  it("resolves root refs", () => {
    const schema = {
      $ref: "#",
      type: "object",
      properties: {
        value: { type: "string" },
      },
    };

    expect(cleanJsonSchemaForAntigravity(schema)).toEqual({
      type: "object",
      properties: {
        value: { type: "string" },
      },
    });
  });

  it("preserves property names that collide with schema keywords", () => {
    const schema = {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
    };

    expect(cleanJsonSchemaForAntigravity(schema)).toEqual({
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
    });
  });

  it("normalizes enum values to strings for string schemas", () => {
    const schema = {
      type: "object",
      properties: {
        value: {
          type: "string",
          enum: [0, 1, 2],
        },
      },
      required: ["value"],
    };

    expect(cleanJsonSchemaForAntigravity(schema)).toEqual({
      type: "object",
      properties: {
        value: {
          type: "string",
          enum: ["0", "1", "2"],
          description: "Allowed: 0, 1, 2",
        },
      },
      required: ["value"],
    });
  });

  it("drops non-string enums for numeric schemas and keeps the hint", () => {
    const schema = {
      type: "object",
      properties: {
        value: {
          type: "integer",
          enum: [0, 1, 2],
        },
      },
      required: ["value"],
    };

    expect(cleanJsonSchemaForAntigravity(schema)).toEqual({
      type: "object",
      properties: {
        value: {
          type: "integer",
          description: "Allowed: 0, 1, 2",
        },
      },
      required: ["value"],
    });
  });
});
