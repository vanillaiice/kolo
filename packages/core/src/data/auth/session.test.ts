import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { memorySecretStore, SESSION_TOKEN_KEY, type SecretStore } from "./secure-store.ts";
import {
  enrol,
  EnrolmentError,
  hasExpired,
  may,
  sessionToken,
  signOut,
  storedSession,
  type Enrolment,
} from "./session.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const OTHER_BUSINESS = "99999999-9999-7999-8999-999999999999";
const USER = "22222222-2222-7222-8222-222222222222";
const OTHER_USER = "66666666-6666-7666-8666-666666666666";
const DEVICE = "33333333-3333-7333-8333-333333333333";
const SESSION = "44444444-4444-7444-8444-444444444444";
const BRANCH = "55555555-5555-7555-8555-555555555555";
const ISSUED = "2026-08-14T09:00:00.000Z";
const EXPIRES = "2026-11-12T09:00:00.000Z";
const AT = new Date("2026-08-14T09:00:01.000Z");

let database: Database;
let secrets: SecretStore & { readonly size: () => number };

beforeEach(() => {
  database = openDatabase();
  migrate(database);
  secrets = memorySecretStore();
});

function login(overrides: Partial<Enrolment> = {}): Enrolment {
  return {
    token: "a-very-secret-token",
    business: { id: BUSINESS, name: "Boutique Chez Jean", currency: "XAF" },
    branches: [],
    user: {
      id: USER,
      name: "Jean Mbarga",
      role: "CASHIER",
      permissions: ["sales.create", "sales.refund"],
    },
    device: { id: DEVICE, label: "Caisse 1", platform: "ANDROID" },
    session: { id: SESSION, issuedAt: ISSUED, expiresAt: EXPIRES },
    ...overrides,
  };
}

describe("enrolling a device", () => {
  it("leaves the till able to say which shop and which person it is", async () => {
    const session = await enrol(database, secrets, login(), AT);

    assert.equal(session.businessId, BUSINESS);
    assert.equal(session.businessName, "Boutique Chez Jean");
    assert.equal(session.userId, USER);
    assert.equal(session.userName, "Jean Mbarga");
    assert.equal(session.deviceId, DEVICE);
    assert.equal(session.sessionId, SESSION);
    assert.equal(session.expiresAt, EXPIRES);
    assert.deepEqual(storedSession(database), session);
  });

  it("keeps the token out of the database and in the keystore", async () => {
    await enrol(database, secrets, login(), AT);

    assert.equal(await sessionToken(secrets), "a-very-secret-token");

    // §37 asks for secure token storage. The point of the keystore is undone
    // if a copy is also sitting in a column, so this looks for one everywhere.
    const tables = database
      .all(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((row) => String(row["name"]));
    for (const table of tables) {
      for (const row of database.all(`SELECT * FROM "${table}"`)) {
        for (const value of Object.values(row)) {
          assert.notEqual(value, "a-very-secret-token", `the token is stored in ${table}`);
        }
      }
    }
  });

  it("writes the token before the rows, so a half-done login is not enrolled", async () => {
    // A label longer than the schema allows makes the second half fail, which
    // is the only ordering that can be observed from outside.
    const tooLong = login({ device: { id: DEVICE, label: "x".repeat(200), platform: "ANDROID" } });

    await assert.rejects(() => enrol(database, secrets, tooLong, AT));

    // The device is not enrolled, which is the answer that matters: it will be
    // asked to log in again, and that login overwrites the orphaned secret.
    assert.equal(storedSession(database), undefined);
    assert.equal(await sessionToken(secrets), "a-very-secret-token");
  });

  it("carries the permissions the server resolved, rather than re-deriving them", async () => {
    const session = await enrol(database, secrets, login(), AT);

    assert.deepEqual(session.permissions, ["sales.create", "sales.refund"]);
    assert.equal(may(session, "sales.refund"), true);
    // A CASHIER's role defaults would put this back if the device re-derived
    // them, which is exactly what a revocation must not survive.
    assert.equal(may(session, "reports.financial"), false);
  });

  it("keeps a branch when the user has one, and says so when they have none", async () => {
    const withBranch = login({
      branches: [{ id: BRANCH, name: "Marché Mokolo" }],
      user: { ...login().user, branchId: BRANCH },
    });

    // The branch is written before the user who points at it. Without it the
    // login fails outright on the foreign key, which is what a branch
    // identifier arriving on its own would do (§42).
    assert.equal((await enrol(database, secrets, withBranch, AT)).branchId, BRANCH);
    assert.equal(database.get(`SELECT name FROM branches WHERE id = ?`, [BRANCH])?.["name"],
      "Marché Mokolo");

    const plain = openDatabase();
    migrate(plain);
    assert.equal((await enrol(plain, memorySecretStore(), login(), AT)).branchId, undefined);
  });

  it("refuses a second shop on a device that already holds one", async () => {
    await enrol(database, secrets, login(), AT);

    const elsewhere = login({
      business: { id: OTHER_BUSINESS, name: "Autre Boutique", currency: "XAF" },
      user: { ...login().user, id: OTHER_USER },
    });

    // Two tenants interleaved in one file cannot be separated afterwards
    // (ADR-008), so this is refused before a single row is written.
    await assert.rejects(
      () => enrol(database, secrets, elsewhere, AT),
      (error: unknown) =>
        error instanceof EnrolmentError && error.code === "another_business",
    );
    assert.equal(storedSession(database)?.businessId, BUSINESS);
  });

  it("refuses a business that does not trade in XAF", async () => {
    const euros = login({ business: { id: BUSINESS, name: "Boutique", currency: "EUR" } });

    // Nothing above this point carries a currency: every amount is minor units
    // of XAF (§46), so accepting this would relabel every price rather than
    // convert it.
    await assert.rejects(
      () => enrol(database, secrets, euros, AT),
      (error: unknown) =>
        error instanceof EnrolmentError && error.code === "unsupported_currency",
    );
    assert.equal(storedSession(database), undefined);
    assert.equal(secrets.size(), 0);
  });

  it("lets a second person take over the same till", async () => {
    await enrol(database, secrets, login(), AT);

    const marie = login({
      token: "marie's-token",
      user: { id: OTHER_USER, name: "Marie Ngo", role: "MANAGER", permissions: ["reports.financial"] },
      session: { id: "77777777-7777-7777-8777-777777777777", issuedAt: ISSUED, expiresAt: EXPIRES },
    });
    const session = await enrol(database, secrets, marie, AT);

    assert.equal(session.userId, OTHER_USER);
    assert.equal(session.deviceId, DEVICE, "the till keeps its own identity across a shift change");
    assert.equal(await sessionToken(secrets), "marie's-token");
    // One row, ever: two would be two answers to "who is this till?".
    assert.equal(database.all(`SELECT id FROM device_session`).length, 1);
  });

  it("refreshes what the shop is called when it is renamed", async () => {
    await enrol(database, secrets, login(), AT);
    const renamed = login({
      business: { id: BUSINESS, name: "Alimentation Chez Jean", currency: "XAF" },
    });

    assert.equal((await enrol(database, secrets, renamed, AT)).businessName, "Alimentation Chez Jean");
  });
});

describe("the schema behind a session", () => {
  it("refuses a second row, so there is one answer to who this till is", async () => {
    await enrol(database, secrets, login(), AT);

    // Structural rather than a convention somebody has to remember: two rows
    // would be two answers with nothing to choose between them.
    assert.throws(() =>
      database.run(
        `INSERT INTO device_session
           (id, session_id, business_id, user_id, device_id, issued_at, expires_at)
         VALUES (2, ?, ?, ?, ?, ?, ?)`,
        [SESSION, BUSINESS, USER, DEVICE, ISSUED, EXPIRES],
      ),
    );
  });

  it("refuses a session that lapses before it was issued", async () => {
    await enrol(database, secrets, login(), AT);

    assert.throws(() =>
      database.run(`UPDATE device_session SET expires_at = ? WHERE id = 1`, [ISSUED]),
    );
  });

  it("refuses a session naming a user this device has never heard of", () => {
    assert.throws(() =>
      database.run(
        `INSERT INTO device_session
           (id, session_id, business_id, user_id, device_id, issued_at, expires_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
        [SESSION, BUSINESS, USER, DEVICE, ISSUED, EXPIRES],
      ),
    );
  });
});

describe("a device that is not enrolled", () => {
  it("says so rather than inventing a shop", () => {
    assert.equal(storedSession(database), undefined);
  });

  it("has no token to present", async () => {
    assert.equal(await sessionToken(secrets), undefined);
  });
});

describe("how long a session lasts", () => {
  it("is not expired before it expires, and is after", async () => {
    const session = await enrol(database, secrets, login(), AT);

    assert.equal(hasExpired(session, new Date("2026-11-12T08:59:59.000Z")), false);
    assert.equal(hasExpired(session, new Date(EXPIRES)), true);
    assert.equal(hasExpired(session, new Date("2026-11-13T00:00:00.000Z")), true);
  });

  it("is still readable once lapsed, so the screen decides what to do", async () => {
    const short = login({ session: { id: SESSION, issuedAt: ISSUED, expiresAt: "2026-08-15T09:00:00.000Z" } });
    await enrol(database, secrets, short, AT);

    // A till that went blank overnight because a token lapsed would lose the
    // shop its morning. The session is returned; expiry is reported separately.
    const stored = storedSession(database);
    assert.notEqual(stored, undefined);
    assert.equal(hasExpired(stored!, new Date("2026-09-01T00:00:00.000Z")), true);
  });
});

describe("signing out", () => {
  it("forgets who was logged in, and the token with them", async () => {
    await enrol(database, secrets, login(), AT);

    await signOut(database, secrets);

    assert.equal(storedSession(database), undefined);
    assert.equal(await sessionToken(secrets), undefined);
    assert.equal(secrets.size(), 0);
  });

  it("keeps everything the shop recorded, including what has not synced", async () => {
    await enrol(database, secrets, login(), AT);
    database.run(
      `INSERT INTO sync_outbox (event_id, business_id, user_id, device_id, type, payload,
                                occurred_at, sequence, attempts)
       VALUES ('88888888-8888-7888-8888-888888888888', ?, ?, ?, 'STOCK_MOVED', '{}', ?, 1, 0)`,
      [BUSINESS, USER, DEVICE, ISSUED],
    );

    await signOut(database, secrets);

    // Signing out is not a decision to discard a day's trading.
    assert.equal(database.all(`SELECT event_id FROM sync_outbox`).length, 1);
    assert.equal(database.all(`SELECT id FROM businesses`).length, 1);
  });

  it("can be repeated, because a till may be signed out twice", async () => {
    await enrol(database, secrets, login(), AT);

    await signOut(database, secrets);
    await signOut(database, secrets);

    assert.equal(storedSession(database), undefined);
  });

  it("lets the same person log back in and find their work", async () => {
    await enrol(database, secrets, login(), AT);
    await signOut(database, secrets);

    const session = await enrol(database, secrets, login({ token: "fresh" }), AT);

    assert.equal(session.businessId, BUSINESS);
    assert.equal(await secrets.read(SESSION_TOKEN_KEY), "fresh");
  });
});

describe("permissions that cannot be read", () => {
  it("are treated as none, which hides buttons rather than showing wrong ones", async () => {
    await enrol(database, secrets, login(), AT);
    // A row written by a build that stored something else, or corrupted since.
    database.run(`UPDATE users SET permissions = '"not-a-list"' WHERE id = ?`, [USER]);

    assert.deepEqual(storedSession(database)?.permissions, []);
  });

  it("ignore entries that are not names", async () => {
    await enrol(database, secrets, login(), AT);
    database.run(`UPDATE users SET permissions = '["sales.create", 7, null]' WHERE id = ?`, [USER]);

    assert.deepEqual(storedSession(database)?.permissions, ["sales.create"]);
  });
});
