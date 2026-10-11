/**
 * How the sync engine reaches the server.
 *
 * The engine takes this interface rather than calling `fetch` itself, so its
 * behaviour (what a rejection means, what a lost response means, when to stop)
 * is testable without a network. That behaviour is where the difficulty is; the
 * HTTP below it is the easy part.
 */

/** An event on its way to the server. */
export interface OutgoingEvent {
  readonly event_id: string;
  readonly user_id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurred_at: string;
  readonly sequence: number;
}

/** What the server says about one pushed event. */
export interface EventResult {
  readonly event_id: string;
  /**
   * "accepted", "duplicate", or "rejected" — or absent, which means the server
   * could not settle the event and the device should send it again.
   */
  readonly status?: string;
  readonly reason?: string;
  /** Whether the device should send this event again. */
  readonly retry?: boolean;
}

/** The server's answer to a push. */
export interface PushResult {
  readonly results: readonly EventResult[];
  readonly cursor: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: number;
}

/** An event arriving from another device. */
export interface IncomingEvent {
  readonly event_id: string;
  readonly device_id: string;
  readonly user_id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurred_at: string;
  readonly sequence: number;
}

/** The server's answer to a pull. */
export interface PullResult {
  readonly events: readonly IncomingEvent[];
  readonly cursor: number;
  readonly has_more: boolean;
}

/** The transport the engine drives. */
export interface SyncTransport {
  push(events: readonly OutgoingEvent[]): Promise<PushResult>;
  pull(cursor: number, limit: number): Promise<PullResult>;
}

/**
 * Raised when the server could not be reached or did not answer usefully.
 *
 * This is deliberately one error rather than a taxonomy. To the engine, a dead
 * network, a timeout, and a 500 all mean the same thing: nothing was settled,
 * keep what is queued, try later. §45 assumes this is the normal case, not an
 * exceptional one.
 */
export class TransportError extends Error {
  /** The HTTP status, when there was one. */
  readonly status: number | undefined;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "TransportError";
    this.status = options?.status;
  }
}

/** What an HTTP transport needs to know. */
export interface HttpTransportOptions {
  /** The API root, such as https://api.kolo.cm/api/v1 */
  readonly baseUrl: string;
  /** Supplies the current session token, which login replaces. */
  readonly token: () => string;
  /** Defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** How long to wait before giving up on one request. */
  readonly timeoutMs?: number;
}

/** How long a single request may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** A transport that talks to the KOLO API over HTTP. */
export class HttpTransport implements SyncTransport {
  readonly #baseUrl: string;
  readonly #token: () => string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: HttpTransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async push(events: readonly OutgoingEvent[]): Promise<PushResult> {
    return await this.#request<PushResult>("POST", "/sync/push", { events });
  }

  async pull(cursor: number, limit: number): Promise<PullResult> {
    const query = new URLSearchParams({ cursor: String(cursor), limit: String(limit) });
    return await this.#request<PullResult>("GET", `/sync/pull?${query.toString()}`);
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token()}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new TransportError("the server could not be reached", { cause });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The body may carry the API's error code, which is worth keeping in the
      // message even though the engine does not branch on it.
      throw new TransportError(
        `the server answered ${response.status}: ${await describeFailure(response)}`,
        { status: response.status },
      );
    }

    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new TransportError("the server's answer was not readable", { cause });
    }
  }
}

async function describeFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return body.error?.code ?? body.error?.message ?? "no reason given";
  } catch {
    return "no reason given";
  }
}
