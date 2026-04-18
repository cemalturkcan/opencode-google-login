import { afterEach, describe, expect, it } from "bun:test";
import { __testExports } from "../src/open-browser.ts";

describe("getOpenBrowserCommand", () => {
  const originalBrowser = process.env.BROWSER;

  afterEach(() => {
    if (originalBrowser === undefined) {
      delete process.env.BROWSER;
      return;
    }
    process.env.BROWSER = originalBrowser;
  });

  it("prefers the BROWSER environment variable", () => {
    process.env.BROWSER = "firefox";

    expect(__testExports.getOpenBrowserCommand("https://example.com")).toEqual({
      command: "firefox",
      args: ["https://example.com"],
    });
  });

  it("returns a platform opener when BROWSER is not set", () => {
    delete process.env.BROWSER;

    const command = __testExports.getOpenBrowserCommand("https://example.com");
    expect(command.args.at(-1)).toBe("https://example.com");
    expect(typeof command.command).toBe("string");
    expect(command.command.length).toBeGreaterThan(0);
  });

  it("uses open on darwin", () => {
    delete process.env.BROWSER;

    expect(__testExports.getOpenBrowserCommand("https://example.com", "darwin")).toEqual({
      command: "open",
      args: ["https://example.com"],
    });
  });

  it("uses cmd start on win32", () => {
    delete process.env.BROWSER;

    expect(__testExports.getOpenBrowserCommand("https://example.com", "win32")).toEqual({
      command: "cmd.exe",
      args: ["/c", "start", "", "https://example.com"],
    });
  });

  it("uses xdg-open on linux", () => {
    delete process.env.BROWSER;

    expect(__testExports.getOpenBrowserCommand("https://example.com", "linux")).toEqual({
      command: "xdg-open",
      args: ["https://example.com"],
    });
  });
});
