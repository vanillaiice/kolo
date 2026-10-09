import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpTransport, TransportError } from "./transport.ts";

/** Captures what the transport asked for, and answers as told. */
function stubFetch(
  answer: { status?: number; body?: unknown; throws?: unknown } = {},
): { calls: { url: string; init: RequestInit }[]; fetch: typeof globalThis.fetch } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (answer.throws !== undefined) {
      throw answer.throws;
    }
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("pushing over HTTP", () => {
  it("posts the events to the push endpoint", async () => {
    const stub = stubFetch({ body: { results: [], cursor: 0, accepted: 0, duplicates: 0, rejected: 0 } });
    const transport = new HttpTransport({
      baseUrl: "https://api.kolo.cm/api/v1",
      token: () => "a-token",
      fetch: stub.fetch,
    });

    await transport.push([
      { event_id: "e1", user_id: "u1", type: "STOCK_MOVED", payload: {}, occurred_at: "now", sequence: 1 },
    ]);

    const [call] = stub.calls;
    assert.equal(call?.url, "https://api.kolo.cm/api/v1/sync/push");
    assert.equal(call?.init.method, "POST");
    assert.deepEqual(JSON.parse(String(call?.init.body)), {
      events: [
        { event_id: "e1", user_id: "u1", type: "STOCK_MOVED", payload: {}, occurred_at: "now", sequence: 1 },
      ],
    });
  });

  it("sends the session token, read fresh each time", async () => {
    const stub = stubFetch({ body: {} });
    let token = "first";
    const transport = new HttpTransport({
      baseUrl: "https://api.kolo.cm/api/v1",
      token: () => token,
      fetch: stub.fetch,
    });

    await transport.pull(0, 10);
    token = "second";
    await transport.pull(0, 10);

    // A login partway through a session must not leave the transport holding
    // the old token, which would 401 until the app restarted.
    assert.equal(headerOf(stub.calls[0]?.init, "Authorization"), "Bearer first");
    assert.equal(headerOf(stub.calls[1]?.init, "Authorization"), "Bearer second");
  });

  it("trims a trailing slash from the base rather than doubling it", async () => {
    const stub = stubFetch({ body: {} });
    const transport = new HttpTransport({
      baseUrl: "https://api.kolo.cm/api/v1///",
      token: () => "t",
      fetch: stub.fetch,
    });

    await transport.pull(0, 10);

    assert.match(String(stub.calls[0]?.url), /v1\/sync\/pull\?/);
  });
});

describe("pulling over HTTP", () => {
  it("asks from the cursor", async () => {
    const stub = stubFetch({ body: { events: [], cursor: 12, has_more: false } });
    const transport = new HttpTransport({
      baseUrl: "https://api.kolo.cm/api/v1",
      token: () => "t",
      fetch: stub.fetch,
    });

    const result = await transport.pull(12, 50);

    assert.equal(stub.calls[0]?.url, "https://api.kolo.cm/api/v1/sync/pull?cursor=12&limit=50");
    assert.equal(result.cursor, 12);
  });
});

describe("when the request does not succeed", () => {
  it("reports an unreachable server as a transport failure", async () => {
    const stub = stubFetch({ throws: new TypeError("network request failed") });
    const transport = new HttpTransport({
      baseUrl: "https://api.kolo.cm/api/v1",
      token: () => "t",
      fetch: stub.fetch,
    });

    await assert.rejects(() => transport.pull(0, 10), TransportError);
  });

  it("carries the status and the API's error code", async () => {
    const stub = stubFetch({
      status: 401,
      body: { error: { code: "unauthenticated", message: "Sign in to continue." } },
    });
    const transport = new HttpTransport({
      baseUrl: "https://api.kolo.cm/api/v1",
      token: () => "t",
      fetch: stub.fetch,
    });

    await assert.rejects(
      () => transport.pull(0, 10),
      (error: unknown) => {
        assert.ok(error instanceof TransportError);
        assert.equal(error.status, 401);
        assert.match(error.message, /unauthenticated/);
        return true;
      },
    );
  });

  it("survives a failure whose body is not JSON", async () => {
    const fetch = (async () =>
      new Response("<html>gateway timeout</html>", { status: 504 })) as unknown as typeof globalThis.fetch;
    const transport = new HttpTransport({
      baseUrl: "https://api.kolo.cm/api/v1",
      token: () => "t",
      fetch,
    });

    // A captive portal or a proxy answers with HTML, and the engine must see an
    // ordinary transport failure rather than a parse error.
    await assert.rejects(
      () => transport.pull(0, 10),
      (error: unknown) => error instanceof TransportError && error.status === 504,
    );
  });

  it("reports an unreadable success body rather than returning nonsense", async () => {
    const fetch = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof globalThis.fetch;
    const transport = new HttpTransport({
      baseUrl: "https://api.kolo.cm/api/v1",
      token: () => "t",
      fetch,
    });

    await assert.rejects(() => transport.pull(0, 10), /not readable/);
  });

  it("gives up on a request that never answers", async () => {
    const fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as unknown as typeof globalThis.fetch;

    const transport = new HttpTransport({
      baseUrl: "https://api.kolo.cm/api/v1",
      token: () => "t",
      fetch,
      timeoutMs: 10,
    });

    // §45 assumes links that hang rather than fail. Without a timeout a sync
    // would wait forever and the next one could never start.
    await assert.rejects(() => transport.pull(0, 10), TransportError);
  });
});

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}
