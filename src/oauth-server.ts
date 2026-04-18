import { createServer } from "node:http";
import { REDIRECT_URI } from "./constants.ts";

export type OAuthListener = {
  waitForCallback(): Promise<URL>;
  close(): Promise<void>;
};

function shouldBindPublicly(): boolean {
  return Boolean(
    process.env.SSH_CLIENT ||
    process.env.SSH_CONNECTION ||
    process.env.SSH_TTY ||
    process.env.REMOTE_CONTAINERS ||
    process.env.CODESPACES,
  );
}

export function shouldUseManualOAuthFlow(): boolean {
  return Boolean(process.env.OPENCODE_HEADLESS) || shouldBindPublicly();
}

export async function startOAuthListener(
  timeoutMs = 5 * 60 * 1000,
  redirectUri = REDIRECT_URI,
): Promise<OAuthListener> {
  const redirectUrl = new URL(redirectUri);
  const bindHost = shouldBindPublicly() ? "0.0.0.0" : "127.0.0.1";
  const pathName = redirectUrl.pathname || "/";
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveCallback!: (url: URL) => void;
  let rejectCallback!: (error: Error) => void;

  const callbackPromise = new Promise<URL>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    if (!request.url) {
      response.writeHead(400).end("Missing callback URL");
      return;
    }

    const callbackUrl = new URL(request.url, `${redirectUrl.protocol}//${redirectUrl.host}`);
    if (callbackUrl.pathname !== pathName) {
      response.writeHead(404).end("Not found");
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<html><body><p>Authentication complete. You can close this tab.</p></body></html>",
    );
    resolveCallback(callbackUrl);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(redirectUrl.port), bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  timer = setTimeout(() => {
    rejectCallback(new Error("OAuth callback timed out"));
    server.close();
  }, timeoutMs);

  return {
    waitForCallback() {
      return callbackPromise;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
