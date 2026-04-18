import { spawn } from "node:child_process";
import { log } from "./logger.ts";

type BrowserCommand = {
  command: string;
  args: string[];
};

export function getOpenBrowserCommand(
  url: string,
  platformName: NodeJS.Platform = process.platform,
): BrowserCommand {
  const preferredBrowser = process.env.BROWSER?.trim();
  if (preferredBrowser) {
    return {
      command: preferredBrowser,
      args: [url],
    };
  }

  if (platformName === "darwin") {
    return {
      command: "open",
      args: [url],
    };
  }

  if (platformName === "win32") {
    return {
      command: "cmd.exe",
      args: ["/c", "start", "", url],
    };
  }

  return {
    command: "xdg-open",
    args: [url],
  };
}

export function openBrowser(url: string): void {
  try {
    const { command, args } = getOpenBrowserCommand(url);
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (error) => {
      log.warn("Failed to open browser", { url, error: String(error) });
    });
    child.unref();
  } catch (error) {
    log.warn("Failed to open browser", { url, error: String(error) });
  }
}

export const __testExports = {
  getOpenBrowserCommand,
};
