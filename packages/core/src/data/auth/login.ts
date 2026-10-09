/**
 * Logging in (ADR-012), which is the one thing here that needs the network.
 *
 * §4 enumerates what must work offline — products, stock, sales, returns,
 * customers, payments, purchases, expenses, cash, local reports — and first
 * login is deliberately not among them. PIN hashes never leave the server, so
 * a device that has never spoken to it has nothing to check a PIN against. That
 * gap is stated in ADR-012 rather than worked around: everything *after*
 * enrolment runs offline, for as long as the session lasts.
 *
 * The transport is an interface for the reason the sync engine's is: what
 * happens when the server refuses, or cannot be reached, is the part worth
 * testing, and it is testable here without a network.
 */

import type { Database } from "../database/driver.ts";
import type { SecretStore } from "./secure-store.ts";
import { enrol, type Enrolment, type Session } from "./session.ts";

/** What someone types to log in, plus what this installation is. */
export interface Credentials {
  /** The shop being joined. It is not derivable: a phone number identifies a
   * person within one business, not globally (ADR-012). */
  readonly businessId: string;
  readonly phone: string;
  readonly pin: string;
  /** How this installation names itself when it is registered. */
  readonly device: {
    /** Set once this device is registered, so a second login is not a second
     * device — a till that registered itself again on every shift would spread
     * one shop's history across a dozen device identities (§28). */
    readonly id?: string | undefined;
    readonly label?: string | undefined;
    readonly platform?: string | undefined;
  };
}

/** What logging in needs from the server. */
export interface AuthTransport {
  login(credentials: Credentials): Promise<Enrolment>;
}

/** Why a login did not succeed. */
export type LoginProblem =
  /** The phone number or the PIN was wrong — deliberately not which. */
  | "invalid_credentials"
  /** Right PIN, but the account, device or business is out of service. */
  | "account_suspended"
  | "device_suspended"
  | "business_suspended"
  /** Too many failed attempts; `retryAfterSeconds` says how long to wait. */
  | "too_many_attempts"
  /** The server would not accept the request as sent. */
  | "invalid_request"
  /** The server could not be reached, which §45 treats as ordinary. */
  | "unreachable"
  /** The server answered with something this build cannot use. */
  | "server_error";

/**
 * Raised when a login fails.
 *
 * It carries a code rather than a sentence because the screen speaks French and
 * English (§44), and a client that matched on the server's English prose would
 * break the moment it was translated.
 */
export class LoginError extends Error {
  readonly code: LoginProblem;
  /** How long to wait before trying again, when the server said. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: LoginProblem,
    message: string,
    options?: { cause?: unknown; retryAfterSeconds?: number | undefined },
  ) {
    super(message, options);
    this.name = "LoginError";
    this.code = code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

/**
 * Logs in and enrols this device, returning the session it may now trade under.
 *
 * The device identity comes from what this installation already holds rather
 * than from the caller, so a shift change reuses the till's identity instead of
 * registering a new one.
 */
export async function logIn(
  database: Database,
  secrets: SecretStore,
  transport: AuthTransport,
  credentials: Credentials,
  now: Date = new Date(),
): Promise<Session> {
  const enrolment = await transport.login({
    ...credentials,
    device: { ...credentials.device, id: credentials.device.id ?? deviceOnThisInstall(database) },
  });
  return await enrol(database, secrets, enrolment, now);
}

/** The device identity this installation has already been given, if any. */
function deviceOnThisInstall(database: Database): string | undefined {
  const row = database.get(`SELECT device_id FROM device_session WHERE id = 1`);
  if (row !== undefined) {
    return String(row["device_id"]);
  }
  // A device that was signed out keeps its identity: the row above is gone, but
  // the installation is the same one the server registered, and its unsynced
  // events are still queued against it.
  const device = database.get(`SELECT id FROM devices ORDER BY created_at LIMIT 1`);
  return device === undefined ? undefined : String(device["id"]);
}

/** What an HTTP login needs to know. */
export interface HttpAuthTransportOptions {
  /** The API root, such as https://api.kolo.cm/api/v1 */
  readonly baseUrl: string;
  /** Defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** How long to wait before giving up on the request. */
  readonly timeoutMs?: number;
}

/** How long a login may take before it is abandoned. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 30_000;

/** A transport that logs in over HTTP. */
export class HttpAuthTransport implements AuthTransport {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: HttpAuthTransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  }

  async login(credentials: Credentials): Promise<Enrolment> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_id: credentials.businessId,
          phone: credentials.phone,
          pin: credentials.pin,
          device: deviceBody(credentials),
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new LoginError("unreachable", "the server could not be reached", { cause });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw await failureOf(response);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new LoginError("server_error", "the server's answer was not readable", { cause });
    }
    return toEnrolment(body);
  }
}

/**
 * The device half of the request.
 *
 * An identifier names an installation the server already knows; a label and
 * platform register a new one. Sending both would be ambiguous, and the server
 * refuses a field it does not expect, so exactly one shape goes out.
 */
function deviceBody(credentials: Credentials): Record<string, string> {
  const { id, label, platform } = credentials.device;
  if (id !== undefined && id !== "") {
    return { id };
  }
  return {
    ...(label === undefined ? {} : { label }),
    ...(platform === undefined ? {} : { platform }),
  };
}

/** Turns a refused response into the problem it describes. */
async function failureOf(response: Response): Promise<LoginError> {
  const code = await codeOf(response);
  const retryAfterSeconds = retryAfter(response);

  switch (code) {
    case "invalid_credentials":
    case "account_suspended":
    case "device_suspended":
    case "business_suspended":
    case "too_many_attempts":
    case "invalid_request":
      return new LoginError(code, `the server refused the login: ${code}`, { retryAfterSeconds });
    default:
      // Including 401 "unauthenticated" and anything this build has not seen:
      // reported as the server's problem rather than guessed at, since acting
      // on a code we do not understand is how a device retries forever.
      return new LoginError(
        "server_error",
        `the server answered ${response.status}: ${code ?? "no reason given"}`,
        { retryAfterSeconds },
      );
  }
}

async function codeOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("Retry-After");
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Reads the server's answer into an {@link Enrolment}.
 *
 * Everything required is checked here rather than trusted, because what follows
 * writes it into the tables every later query is scoped by: a login that stored
 * an empty business identifier would leave a till recording sales that belong
 * to nobody.
 */
function toEnrolment(body: unknown): Enrolment {
  const root = asObject(body, "the answer");
  const business = asObject(root["business"], "business");
  const branches = Array.isArray(root["branches"]) ? root["branches"] : [];
  const user = asObject(root["user"], "user");
  const device = asObject(root["device"], "device");
  const session = asObject(root["session"], "session");

  return {
    token: text(root["token"], "token"),
    business: {
      id: text(business["id"], "business.id"),
      name: text(business["name"], "business.name"),
      currency: text(business["currency"], "business.currency"),
    },
    branches: branches.map((entry: unknown, index: number) => {
      const branch = asObject(entry, `branches[${index}]`);
      return {
        id: text(branch["id"], `branches[${index}].id`),
        name: text(branch["name"], `branches[${index}].name`),
      };
    }),
    user: {
      id: text(user["id"], "user.id"),
      name: text(user["name"], "user.name"),
      role: text(user["role"], "user.role"),
      branchId: optionalText(user["branch_id"]),
      permissions: Array.isArray(user["permissions"])
        ? user["permissions"].filter((entry): entry is string => typeof entry === "string")
        : [],
    },
    device: {
      id: text(device["id"], "device.id"),
      label: text(device["label"], "device.label"),
      platform: text(device["platform"], "device.platform"),
      branchId: optionalText(device["branch_id"]),
    },
    session: {
      id: text(session["id"], "session.id"),
      issuedAt: text(session["issued_at"], "session.issued_at"),
      expiresAt: text(session["expires_at"], "session.expires_at"),
    },
  };
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LoginError("server_error", `the server's answer has no ${what}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new LoginError("server_error", `the server's answer has no ${what}`);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
