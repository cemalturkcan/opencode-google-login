import { describe, expect, it } from "bun:test";
import { __testExports } from "../src/account-store.ts";

describe("buildAccountId", () => {
  it("uses refresh-token core even when email exists", () => {
    expect(__testExports.buildAccountId("refresh-token", "User@Example.com ")).toBe(
      __testExports.buildAccountId("refresh-token"),
    );
  });

  it("falls back to a stable refresh hash", () => {
    const first = __testExports.buildAccountId("refresh-token");
    const second = __testExports.buildAccountId("refresh-token");

    expect(first).toBe(second);
    expect(first).toHaveLength(16);
  });

  it("treats packed refresh values for the same account as one identity", () => {
    const first = __testExports.buildAccountId("refresh-token||project-a");
    const second = __testExports.buildAccountId("refresh-token||project-b");

    expect(first).toBe(second);
  });
});
