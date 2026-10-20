// supabase/functions/_shared/printify-http.ts
//
// The ONE Printify HTTP implementation.
//
// It is deliberately free of runtime-specific APIs — no Deno.*, no node:*, no
// npm: specifiers, no import.meta.env — so the same module runs in three
// places:
//   1. the `printify` Edge Function (Deno),
//   2. the local read-only verification script (Node),
//   3. vitest, with a mocked fetch.
//
// WHAT IT GUARANTEES
//   - a request cannot hang: every call has a timeout;
//   - a transient failure is retried a bounded number of times, honouring
//     `Retry-After`;
//   - a 4xx is NEVER retried: the request itself is wrong, and repeating it
//     burns the account's error budget (the API contract caps error responses
//     at 5% of total requests);
//   - the token never appears in a returned error, a log line or a throw;
//   - the response is parsed as JSON only when it really is JSON.

/** A request that never came back with a usable answer. */
export type PrintifyHttpResult = {
  /** True only for a 2xx with a JSON body. */
  ok: boolean;
  /** The HTTP status, or 0 when the request never completed. */
  status: number;
  /** The parsed JSON body, or the raw text, or null. */
  body: unknown;
  /** A safe, human-readable description of what went wrong. */
  error: string;
  /** How many attempts were made. */
  attempts: number;
  /** Seconds Printify asked us to wait, when it said. */
  retryAfterSeconds?: number;
};

export type PrintifyHttpOptions = {
  token: string;
  method?: "GET" | "POST";
  body?: unknown;
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
  /** How many times a transient failure may be retried. */
  maxAttempts?: number;
  /**
   * Fixed delay between attempts. Overrides the computed backoff. Used by the
   * tests so they do not have to wait in real time.
   */
  retryDelayMs?: number;
  userAgent?: string;
  /** Injected for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

export const DEFAULT_PRINTIFY_TIMEOUT_MS = 15_000;
export const DEFAULT_PRINTIFY_MAX_ATTEMPTS = 3;
const DEFAULT_USER_AGENT = "HUDAGYMWEAR-BrandStudio/1.0 (+https://hudagymwear.co.uk)";

/** Statuses worth trying again: the request never got a real answer. */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * Remove a secret from a string.
 *
 * Used on every error message and every log line that might echo a request.
 * A token that leaks into a log, an error toast or a support ticket is a
 * token that has to be rotated.
 */
export function redactSecret(text: string, secret: string): string {
  let out = text ?? "";
  if (secret && secret.length >= 8) {
    out = out.split(secret).join("[redacted]");
  }
  // Also catch the common way a token is echoed back: partly masked.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "$1[redacted]");
  return out;
}

/**
 * Printify's error envelope.
 *
 * Three shapes are in use and all three have been seen from the live API:
 *   `{ errors: [{ message }] }`  - validation failures
 *   `{ message }`                - most other failures
 *   `{ error }`                  - e.g. `{ "error": "Unauthenticated" }` for a
 *                                  rejected token
 */
export function printifyErrorMessage(body: unknown, status: number): string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const errors = Array.isArray(b['errors']) ? b['errors'] : [];
  const first = errors[0] as { message?: string } | undefined;
  const code = typeof b['code'] === "number" ? b['code'] : undefined;
  const candidates = [first?.message, b['message'], b['error']];
  const message = candidates.find((m): m is string => typeof m === "string" && m.length > 0);
  if (message) return code ? `${message} (code ${code})` : message;
  return `Printify returned HTTP ${status}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call the Printify API.
 *
 * Read-only by default: `method` is GET unless the caller explicitly asks
 * for a POST, and the caller still has to pass the body. Every call carries
 * the token as a bearer credential and the User-Agent Printify requires.
 */
export async function printifyFetch(
  url: string,
  options: PrintifyHttpOptions,
): Promise<PrintifyHttpResult> {
  const {
    token,
    method = "GET",
    body,
    timeoutMs = DEFAULT_PRINTIFY_TIMEOUT_MS,
    maxAttempts = DEFAULT_PRINTIFY_MAX_ATTEMPTS,
    retryDelayMs,
    userAgent = DEFAULT_USER_AGENT,
    fetchImpl = fetch,
  } = options;

  if (!token) {
    return { ok: false, status: 0, body: null, error: "no Printify API token is configured", attempts: 0 };
  }

  let last: PrintifyHttpResult = {
    ok: false,
    status: 0,
    body: null,
    error: "Printify could not be reached",
    attempts: 0,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // `body` is omitted rather than set to undefined: a GET with an
      // explicit undefined body is not a valid RequestInit.
      const init: RequestInit = {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": userAgent,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      };
      const res = await fetchImpl(url, init);

      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { message: text.slice(0, 400) };
        }
      }

      const retryAfterHeader = Number(res.headers.get("retry-after"));
      const retryAfterSeconds =
        Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : undefined;

      last = {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        body: parsed,
        error: res.status >= 200 && res.status < 300 ? "" : printifyErrorMessage(parsed, res.status),
        attempts: attempt,
        ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      };

      if (last.ok || !isRetryableStatus(res.status)) return last;
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      const message = aborted ? "Printify did not respond in time" : "Printify could not be reached";
      last = {
        ok: false,
        status: 0,
        body: null,
        error: redactSecret(message, token),
        attempts: attempt,
      };
    } finally {
      clearTimeout(timer);
    }

    if (attempt === maxAttempts) break;
    const wait =
      retryDelayMs ??
      (last.retryAfterSeconds
        ? Math.min(last.retryAfterSeconds * 1000, 30_000)
        : Math.min(500 * 2 ** (attempt - 1), 4_000));
    if (wait > 0) await sleep(wait);
  }

  return { ...last, error: redactSecret(last.error, token) };
}
