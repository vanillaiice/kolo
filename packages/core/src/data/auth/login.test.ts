import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { HttpAuthTransport, logIn, LoginError, type Credentials } from "./login.ts";
import { memorySecretStore, type SecretStore } from "./secure-store.ts";
import { enrol, sessionToken, signOut, storedSession, type Enrolment } from "./session.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const DEVICE = "33333333-3333-7333-8333-333333333333";
const SESSION = "44444444-4444-7444-8444-444444444444";
const ISSUED = "2026-08-14T09:00:00.000Z";
const EXPIRES = "2026-11-12T09:00:00.000Z";
const AT = new Date("2026-08-14T09:00:01.000Z");

/** What the server actually answers a login with, in its own spelling. */
function serverAnswer(): unknown {
  return {
    token: "a-very-secret-token",
    expires_at: EXPIRES,
    business: { id: BUSINESS, name: "Boutique Chez Jean", currency: "XAF" },
    branches: [],
    user: {
      id: USER,
      name: "Jean Mbarga",
      role: "CASHIER",
      business_id: BUSINESS,
      permissions: ["sales.create"],
    },
    device: { id: DEVICE, label: "Caisse 1", platform: "ANDROID" },
    session: { id: SESSION, issued_at: ISSUED, expires_at: EXPIRES },
  };
}

/** Captures what the transport asked for, and answers as told. */
function stubFetch(
  answer: { status?: number; body?: unknown; text?: string; headers?: Record<string, string>; throws?: unknown } = {},
): { calls: { url: string; init: RequestInit }[]; fetch: typeof globalThis.fetch } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (answer.throws !== undefined) {
      throw answer.throws;
    }
    return new Response(answer.text ?? JSON.stringify(answer.body ?? serverAnswer()), {
      status: answer.status ?? 200,
      headers: { "Content-Type": "application/json", ...answer.headers },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const credentials: Credentials = {
  businessId: BUSINESS,
  phone: "677123456",
  pin: "1357",
  device: { label: "Caisse 1", platform: "ANDROID" },
};

function refusal(code: string, status: number, headers?: Record<string, string>) {
  return stubFetch({
    status,
    body: { error: { code, message: "in whichever language the server speaks" } },
    ...(headers === undefined ? {} : { headers }),
  });
}

describe("logging in over HTTP", () => {
  it("posts what the server asks for, in the server's own spelling", async () => {
    const stub = stubFetch();
    const transport = new HttpAuthTransport({ baseUrl: "https://api.kolo.cm/api/v1/", fetch: stub.fetch });

    await transport.login(credentials);

    const [call] = stub.calls;
    assert.equal(call?.url, "https://api.kolo.cm/api/v1/auth/login");
    assert.equal(call?.init.method, "POST");
    assert.deepEqual(JSON.parse(String(call?.init.body)), {
      business_id: BUSINESS,
      phone: "677123456",
      pin: "1357",
      device: { label: "Caisse 1", platform: "ANDROID" },
    });
  });

  it("names the device instead of registering a second one", async () => {
    const stub = stubFetch();
    const transport = new HttpAuthTransport({ baseUrl: "https://api.kolo.cm/api/v1", fetch: stub.fetch });

    await transport.login({ ...credentials, device: { id: DEVICE, label: "Caisse 1", platform: "ANDROID" } });

    // Exactly one shape goes out: a till that registered itself again on every
    // shift would spread one shop's history across a dozen identities (§28),
    // and the server refuses a field it does not expect.
    assert.deepEqual(JSON.parse(String(stub.calls[0]?.init.body))["device"], { id: DEVICE });
  });

  it("reads the answer into what the device stores", async () => {
    const stub = stubFetch();
    const transport = new HttpAuthTransport({ baseUrl: "https://api.kolo.cm/api/v1", fetch: stub.fetch });

    const enrolment: Enrolment = await transport.login(credentials);

    assert.equal(enrolment.token, "a-very-secret-token");
    assert.equal(enrolment.business.name, "Boutique Chez Jean");
    assert.equal(enrolment.user.role, "CASHIER");
    assert.deepEqual(enrolment.user.permissions, ["sales.create"]);
    assert.equal(enrolment.device.id, DEVICE);
    assert.equal(enrolment.session.expiresAt, EXPIRES);
    assert.equal(enrolment.user.branchId, undefined);
  });

  it("keeps the branches the answer names", async () => {
    const answer = serverAnswer() as Record<string, unknown>;
    const branch = { id: "55555555-5555-7555-8555-555555555555", name: "Marché Mokolo" };
    const stub = stubFetch({
      body: { ...answer, branches: [branch], user: { ...(answer["user"] as object), branch_id: branch.id } },
    });
    const transport = new HttpAuthTransport({ baseUrl: "https://api.kolo.cm/api/v1", fetch: stub.fetch });

    const enrolment = await transport.login(credentials);

    assert.deepEqual(enrolment.branches, [branch]);
    assert.equal(enrolment.user.branchId, branch.id);
  });
});

describe("a login the server refuses", () => {
  const cases: ReadonlyArray<readonly [string, number, string]> = [
    ["invalid_credentials", 401, "invalid_credentials"],
    ["account_suspended", 403, "account_suspended"],
    ["device_suspended", 403, "device_suspended"],
    ["business_suspended", 403, "business_suspended"],
    ["invalid_request", 400, "invalid_request"],
    ["too_many_attempts", 429, "too_many_attempts"],
  ];

  for (const [code, status, expected] of cases) {
    it(`reports ${code} as a code the screen can translate`, async () => {
      const stub = refusal(code, status);
      const transport = new HttpAuthTransport({ baseUrl: "https://api.kolo.cm/api/v1", fetch: stub.fetch });

      await assert.rejects(
        () => transport.login(credentials),
        (error: unknown) => error instanceof LoginError && error.code === expected,
      );
    });
  }

  it("keeps how long to wait, when the server says", async () => {
    const stub = refusal("too_many_attempts", 429, { "Retry-After": "45" });
    const transport = new HttpAuthTransport({ baseUrl: "https://api.kolo.cm/api/v1", fetch: stub.fetch });

    await assert.rejects(
      () => transport.login(credentials),
      (error: unknown) => error instanceof LoginError && error.retryAfterSeconds === 45,
    );
  });

  it("ignores a Retry-After that is not a number of seconds", async () => {
    const stub = refusal("too_many_attempts", 429, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" });
    const transport = new HttpAuthTransport({ baseUrl: "https://api.kolo.cm/api/v1", fetch: stub.fetch });

    await assert.rejects(
      () => transport.login(credentials),
      (error: unknown) => error instanceof LoginError && error.retryAfterSeconds === undefined,
    );
  });

  it("treats a code it has never seen as the server's problem", async () => {
    const stub = refusal("teapot_suspended", 418);
    const transport = new HttpAuthTransport({ baseUrl: "https://api.kolo.cm/api/v1", fetch: stub.fetch });

    // Acting on a code we do not understand is how a device retries forever.
    await assert.rejects(
      () => transport.login(credentials),
      (error: unknown) => error instanceof LoginError && error.code === "server_error",
    );
  });

  it("survives a failure that is not JSON at all", async () => {
    const stub = stubFetch({ status: 502, text: "<html>gateway</html>" });
    const transport = new HttpAuthTransport({ baseUrl: "https://api.kolo.cm/api/v1", fetch: stub.fetch });

    await assert.rejects(
      () => transport.login(credentials),
      (error: unknown) => error instanceof LoginError && error.code === "server_error",
    );
  });
});

describe("a server that cannot be reached", () => {
  it("is one problem rather than a taxonomy", async () => {
    const stub = stubFetch({ throws: new TypeError("Network request failed") });
    const transport = new HttpAuthTransport({ baseUrl: "https://api.kolo.cm/api/v1", fetch: stub.fetch });

    // §45 assumes this is the normal case: a shop out of coverage is not an
    // exception, and the screen says "try again where there is network".
    await assert.rejects(
      () => transport.login(credentials),
      (error: unknown) => error instanceof LoginError && error.code === "unreachable",
    );
  });

  it("gives up rather than hanging on a server that never answers", async () => {
    const fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      })) as unknown as typeof globalThis.fetch;
    const transport = new HttpAuthTransport({
      baseUrl: "https://api.kolo.cm/api/v1",
      fetch,
      timeoutMs: 5,
    });

    await assert.rejects(
      () => transport.login(credentials),
      (error: unknown) => error instanceof LoginError && error.code === "unreachable",
    );
  });
});

describe("an answer the device cannot use", () => {
  const broken: ReadonlyArray<readonly [string, unknown]> = [
    ["no token", { ...(serverAnswer() as object), token: "" }],
    ["no business", { ...(serverAnswer() as object), business: undefined }],
    ["a business with no id", { ...(serverAnswer() as object), business: { name: "B", currency: "XAF" } }],
    ["no session", { ...(serverAnswer() as object), session: null }],
    ["a user that is a list", { ...(serverAnswer() as object), user: [] }],
    ["not an object at all", "yes"],
  ];

  for (const [name, body] of broken) {
    it(`refuses ${name} rather than storing half a session`, async () => {
      const stub = stubFetch({ body });
      const transport = new HttpAuthTransport({ baseUrl: "https://api.kolo.cm/api/v1", fetch: stub.fetch });

      await assert.rejects(
        () => transport.login(credentials),
        (error: unknown) => error instanceof LoginError && error.code === "server_error",
      );
    });
  }
});

describe("logging in on a device", () => {
  let database: Database;
  let secrets: SecretStore;

  beforeEach(() => {
    database = openDatabase();
    migrate(database);
    secrets = memorySecretStore();
  });

  /** A transport that answers as told and records what it was asked. */
  function stubTransport(): { asked: Credentials[]; login: (c: Credentials) => Promise<Enrolment> } {
    const asked: Credentials[] = [];
    return {
      asked,
      login: (c: Credentials) => {
        asked.push(c);
        return Promise.resolve({
          token: "a-very-secret-token",
          business: { id: BUSINESS, name: "Boutique Chez Jean", currency: "XAF" },
          branches: [],
          user: { id: USER, name: "Jean Mbarga", role: "CASHIER", permissions: ["sales.create"] },
          device: { id: DEVICE, label: "Caisse 1", platform: "ANDROID" },
          session: { id: SESSION, issuedAt: ISSUED, expiresAt: EXPIRES },
        });
      },
    };
  }

  it("leaves the device enrolled and holding its token", async () => {
    const transport = stubTransport();

    const session = await logIn(database, secrets, transport, credentials, AT);

    assert.equal(session.businessId, BUSINESS);
    assert.deepEqual(storedSession(database), session);
    assert.equal(await sessionToken(secrets), "a-very-secret-token");
  });

  it("presents the identity this installation was already given", async () => {
    const transport = stubTransport();
    await logIn(database, secrets, transport, credentials, AT);

    await logIn(database, secrets, transport, credentials, AT);

    assert.equal(transport.asked[0]?.device.id, undefined, "the first login has no device yet");
    assert.equal(transport.asked[1]?.device.id, DEVICE);
  });

  it("keeps that identity across a sign-out", async () => {
    const transport = stubTransport();
    await logIn(database, secrets, transport, credentials, AT);
    await signOut(database, secrets);

    await logIn(database, secrets, transport, credentials, AT);

    // The session row is gone, but the installation is the same one the server
    // registered, and its unsynced events are still queued against it.
    assert.equal(transport.asked[1]?.device.id, DEVICE);
  });

  it("does not overwrite a session when the server refuses", async () => {
    await enrol(database, secrets, {
      token: "the-good-token",
      business: { id: BUSINESS, name: "Boutique Chez Jean", currency: "XAF" },
      branches: [],
      user: { id: USER, name: "Jean Mbarga", role: "CASHIER", permissions: [] },
      device: { id: DEVICE, label: "Caisse 1", platform: "ANDROID" },
      session: { id: SESSION, issuedAt: ISSUED, expiresAt: EXPIRES },
    }, AT);

    const refusing = {
      login: () => Promise.reject(new LoginError("invalid_credentials", "wrong")),
    };
    await assert.rejects(() => logIn(database, secrets, refusing, credentials, AT));

    // A cashier who mistypes their PIN must not sign the till out.
    assert.equal(storedSession(database)?.sessionId, SESSION);
    assert.equal(await sessionToken(secrets), "the-good-token");
  });
});
