/**
 * Where the session token is kept (§37, ADR-012).
 *
 * The token is the one thing on the device that is a *credential* rather than a
 * record. Everything else in `kolo.db` (sales, prices, what a customer owes)
 * describes what happened; the token lets whoever holds it act as this till
 * against the server. §37 asks for secure token storage, so it goes to the
 * platform keystore rather than into a column beside the business data.
 *
 * ## Why the module is passed in
 *
 * This file does not import `expo-secure-store`, for the reason `expo-sqlite.ts`
 * does not import `expo-sqlite` (ADR-016). It describes the three methods the
 * data layer needs and takes them as an argument; `store-on-device.ts` hands
 * the real module over on one line. So "expo-secure-store's API looks like
 * this" is checked by the compiler at exactly one call site, and everything
 * above can be tested under Node without a device.
 *
 * What no amount of Node testing covers is the keystore itself, which needs a
 * device: the same honest gap ADR-016 states for SQLite.
 */

/** The slice of the native secure store this adapter uses. */
export interface NativeSecureStore {
  /** Returns the value stored under a key, or null when there is none. */
  getItemAsync(key: string): Promise<string | null>;
  /** Stores a value under a key. */
  setItemAsync(key: string, value: string): Promise<void>;
  /** Removes whatever is stored under a key. */
  deleteItemAsync(key: string): Promise<void>;
}

/**
 * A place to keep a secret.
 *
 * Asynchronous, unlike the database, because the keystore genuinely is: reading
 * it can involve the platform's key manager. That is why the token is *not*
 * part of {@link Session}; a session is read synchronously while drawing a
 * screen, and only the sync engine needs the token.
 */
export interface SecretStore {
  /** Returns the secret under a key, or undefined when there is none. */
  read(key: string): Promise<string | undefined>;
  /** Stores a secret under a key, replacing whatever was there. */
  write(key: string, secret: string): Promise<void>;
  /** Removes the secret under a key. Removing what is not there is not an error. */
  forget(key: string): Promise<void>;
}

/** The key the session token is stored under. */
export const SESSION_TOKEN_KEY = "kolo.session.token";

/** Raised when the keystore could not be read or written. */
export class SecretStoreError extends Error {
  /** The key involved, which is never itself a secret. */
  readonly key: string;

  constructor(message: string, key: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecretStoreError";
    this.key = key;
  }
}

/**
 * Wraps a native secure store as a {@link SecretStore}.
 *
 * The translations are small and both are deliberate: `null` becomes
 * `undefined`, so callers have one way to say "nothing stored" (the same
 * translation `expo-sqlite.ts` makes for a missing row), and a thrown platform
 * error becomes a {@link SecretStoreError} that names the key but never the
 * value: an error that reached a log carrying the token would defeat the point
 * of storing it here.
 */
export function nativeSecretStore(native: NativeSecureStore): SecretStore {
  return {
    async read(key: string): Promise<string | undefined> {
      try {
        return (await native.getItemAsync(key)) ?? undefined;
      } catch (cause) {
        throw new SecretStoreError("the secure store could not be read", key, { cause });
      }
    },

    async write(key: string, secret: string): Promise<void> {
      try {
        await native.setItemAsync(key, secret);
      } catch (cause) {
        throw new SecretStoreError("the secure store could not be written", key, { cause });
      }
    },

    async forget(key: string): Promise<void> {
      try {
        await native.deleteItemAsync(key);
      } catch (cause) {
        throw new SecretStoreError("the secure store could not be cleared", key, { cause });
      }
    },
  };
}

/**
 * A {@link SecretStore} held in memory, for tests.
 *
 * It is here rather than in a test file because both the tests of this layer
 * and the tests of everything above it need one, and two copies would drift.
 * Nothing in the app builds one: a device that kept its token in memory would
 * ask for a PIN on every restart.
 */
export function memorySecretStore(): SecretStore & { readonly size: () => number } {
  const secrets = new Map<string, string>();
  return {
    read: (key) => Promise.resolve(secrets.get(key)),
    write: (key, secret) => {
      secrets.set(key, secret);
      return Promise.resolve();
    },
    forget: (key) => {
      secrets.delete(key);
      return Promise.resolve();
    },
    size: () => secrets.size,
  };
}
