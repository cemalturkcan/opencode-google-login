import { log } from "./logger.ts";

function isNonRetryable429(body: string): boolean {
  return (
    body.includes("Extra usage is required for long context requests") ||
    body.includes("extra_usage") ||
    body.includes("usage_limit_exceeded") ||
    body.includes("billing_error")
  );
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3,
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, init);

    if ((res.status === 429 || res.status === 529) && i < retries - 1) {
      if (res.status === 429) {
        const body = await res
          .clone()
          .text()
          .catch(() => "");
        if (body && isNonRetryable429(body)) {
          log.debug("Rate limit is terminal, skipping retry", {
            status: res.status,
          });
          return res;
        }
      }

      const retryAfter = res.headers.get("retry-after");
      let delayMs: number;

      if (retryAfter) {
        const seconds = Number.parseInt(retryAfter, 10);
        delayMs = Number.isNaN(seconds) ? (i + 1) * 2000 : seconds * 1000;
      } else {
        delayMs = (i + 1) * 2000;
      }

      log.debug("Rate limited, retrying", {
        status: res.status,
        attempt: i + 1,
        delayMs,
        retryAfter: retryAfter ?? "none",
      });

      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    return res;
  }

  return fetch(url, init);
}
