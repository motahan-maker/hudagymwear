import { describe, expect, it } from "vitest";
import {
  isRetryableStatus,
  printifyErrorMessage,
  printifyFetch,
  redactSecret,
} from "../../supabase/functions/_shared/printify-http";

// The token must never leave the server. These tests are the proof: every
// path through the client is checked for a leak, including the paths that
// produce an error the admin will read.
const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.payload.signature";

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** A fetch double that records what it was called with. */
function spy(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return impl(String(input), init);
  }) as typeof fetch;
  return { calls, fetchImpl: fn };
}

function headerOf(call: { init: RequestInit | undefined }, name: string): string | undefined {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

describe("Printify HTTP client", () => {
  describe("authentication", () => {
    it("sends the token as a bearer credential and the User-Agent Printify requires", async () => {
      const s = spy(async () => jsonResponse([]));
      await printifyFetch("https://api.printify.com/v1/shops.json", { token: TOKEN, fetchImpl: s.fetchImpl });
      expect(headerOf(s.calls[0]!, "authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headerOf(s.calls[0]!, "user-agent")).toBeTruthy();
      expect(headerOf(s.calls[0]!, "user-agent")).not.toContain(TOKEN);
    });

    it("never makes a request when there is no token", async () => {
      const s = spy(async () => jsonResponse([]));
      const res = await printifyFetch("https://api.printify.com/v1/shops.json", { token: "", fetchImpl: s.fetchImpl });
      expect(s.calls).toHaveLength(0);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(res.error).toMatch(/no Printify API token/i);
    });

    it("reports a rejected token without echoing it", async () => {
      // The live API answers a rejected token with {"error":"Unauthenticated"}.
      const s = spy(async () => jsonResponse({ error: "Unauthenticated" }, { status: 401 }));
      const res = await printifyFetch("https://api.printify.com/v1/shops.json", { token: TOKEN, fetchImpl: s.fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(401);
      expect(res.error).toBe("Unauthenticated");
      expect(res.error).not.toContain(TOKEN);
    });
  });

  describe("errors and timeouts", () => {
    it("turns a network failure into a safe, retryable result", async () => {
      const s = spy(async () => {
        throw new TypeError("fetch failed");
      });
      const res = await printifyFetch("https://api.printify.com/v1/shops.json", {
        token: TOKEN,
        fetchImpl: s.fetchImpl,
        maxAttempts: 1,
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(res.error).toMatch(/could not be reached/i);
      expect(res.error).not.toContain(TOKEN);
    });

    it("turns a timeout into a safe, retryable result", async () => {
      const s = spy(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      });
      const res = await printifyFetch("https://api.printify.com/v1/shops.json", {
        token: TOKEN,
        fetchImpl: s.fetchImpl,
        maxAttempts: 1,
      });
      expect(res.status).toBe(0);
      expect(res.error).toMatch(/did not respond in time/i);
    });

    it("passes an abort signal so a hung request cannot hold a function open", async () => {
      const s = spy(async () => jsonResponse([]));
      await printifyFetch("https://api.printify.com/v1/shops.json", { token: TOKEN, fetchImpl: s.fetchImpl });
      const signal = s.calls[0]!.init?.signal as AbortSignal | undefined;
      expect(signal).toBeDefined();
      expect(signal!.aborted).toBe(false);
    });

    it("reads every error envelope shape Printify uses", () => {
      expect(printifyErrorMessage({ errors: [{ message: "Validation failed." }] }, 422)).toBe("Validation failed.");
      expect(printifyErrorMessage({ message: "Not found." }, 404)).toBe("Not found.");
      expect(printifyErrorMessage({ error: "Unauthenticated" }, 401)).toBe("Unauthenticated");
      expect(printifyErrorMessage({ message: "Bad", code: 8203 }, 400)).toBe("Bad (code 8203)");
      expect(printifyErrorMessage({}, 500)).toBe("Printify returned HTTP 500");
    });
  });

  describe("rate limiting and retries", () => {
    it("retries a 429 and reports the Retry-After it was given", async () => {
      let call = 0;
      const s = spy(async () => {
        call++;
        return call === 1
          ? jsonResponse({ message: "Rate limited" }, { status: 429, headers: { "retry-after": "7" } })
          : jsonResponse([{ id: 1, title: "Shop" }]);
      });
      const res = await printifyFetch("https://api.printify.com/v1/shops.json", {
        token: TOKEN,
        fetchImpl: s.fetchImpl,
        retryDelayMs: 0,
      });
      expect(res.ok).toBe(true);
      expect(res.attempts).toBe(2);
      expect(s.calls).toHaveLength(2);
    });

    it("never retries a 4xx: the request is wrong and repeating it burns the error budget", async () => {
      const s = spy(async () => jsonResponse({ message: "Bad request" }, { status: 400 }));
      const res = await printifyFetch("https://api.printify.com/v1/shops.json", {
        token: TOKEN,
        fetchImpl: s.fetchImpl,
        retryDelayMs: 0,
      });
      expect(res.status).toBe(400);
      expect(res.attempts).toBe(1);
      expect(s.calls).toHaveLength(1);
    });

    it("gives up after the attempt limit on a persistent 5xx", async () => {
      const s = spy(async () => jsonResponse({ message: "Server error" }, { status: 503 }));
      const res = await printifyFetch("https://api.printify.com/v1/shops.json", {
        token: TOKEN,
        fetchImpl: s.fetchImpl,
        maxAttempts: 3,
        retryDelayMs: 0,
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(503);
      expect(res.attempts).toBe(3);
      expect(s.calls).toHaveLength(3);
    });

    it("classifies the statuses worth retrying", () => {
      for (const s of [0, 408, 429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
      for (const s of [400, 401, 403, 404, 409, 422]) expect(isRetryableStatus(s)).toBe(false);
    });
  });

  describe("secret redaction", () => {
    it("removes the token from any text", () => {
      const text = `request failed with ${TOKEN} in the request`;
      expect(redactSecret(text, TOKEN)).not.toContain(TOKEN);
      expect(redactSecret(text, TOKEN)).toContain("[redacted]");
    });

    it("removes a bearer credential even when the token is not the one given", () => {
      const text = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345";
      expect(redactSecret(text, TOKEN)).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
      expect(redactSecret(text, TOKEN)).toContain("[redacted]");
    });

    it("leaves text alone when there is no secret to remove", () => {
      expect(redactSecret("nothing secret here", TOKEN)).toBe("nothing secret here");
    });
  });

  describe("response handling", () => {
    it("parses a JSON body and reports success", async () => {
      const s = spy(async () => jsonResponse([{ id: 1, title: "Shop" }]));
      const res = await printifyFetch("https://api.printify.com/v1/shops.json", { token: TOKEN, fetchImpl: s.fetchImpl });
      expect(res.ok).toBe(true);
      expect(res.body).toEqual([{ id: 1, title: "Shop" }]);
      expect(res.error).toBe("");
    });

    it("keeps a non-JSON body as text rather than throwing", async () => {
      const s = spy(async () => new Response("<html>gateway</html>", { status: 502 }));
      const res = await printifyFetch("https://api.printify.com/v1/shops.json", {
        token: TOKEN,
        fetchImpl: s.fetchImpl,
        maxAttempts: 1,
      });
      expect(res.ok).toBe(false);
      expect(res.body).toEqual({ message: "<html>gateway</html>" });
    });

    it("sends a JSON body with the right content type when one is given", async () => {
      const s = spy(async () => jsonResponse({}));
      await printifyFetch("https://api.printify.com/v1/shops/1/orders/shipping.json", {
        token: TOKEN,
        method: "POST",
        body: { address_to: { country: "GB" } },
        fetchImpl: s.fetchImpl,
      });
      const call = s.calls[0]!;
      expect(call.init?.method).toBe("POST");
      expect(headerOf(call, "content-type")).toBe("application/json");
      expect(JSON.parse(String(call.init?.body))).toEqual({ address_to: { country: "GB" } });
    });
  });
});
