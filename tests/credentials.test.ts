import { describe, expect, it } from "bun:test";
import { __testExports } from "../src/credentials.ts";

describe("scanSerializedState", () => {
  it("extracts refresh and access tokens from nested base64 payloads", () => {
    const inner = Buffer.from(
      `token:${"ya29.test-access-token"};refresh:${"g1//test-refresh-token"}`,
      "utf8",
    ).toString("base64url");
    const outer = Buffer.from(`sentinel:${inner}`, "utf8").toString("base64url");

    expect(__testExports.scanSerializedState(outer)).toEqual({
      access: "ya29.test-access-token",
      refresh: "g1//test-refresh-token",
    });
  });

  it("returns null when no tokens exist", () => {
    expect(
      __testExports.scanSerializedState(Buffer.from("no tokens", "utf8").toString("base64url")),
    ).toBeNull();
  });
});
