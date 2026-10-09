import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  memorySecretStore,
  nativeSecretStore,
  SecretStoreError,
  SESSION_TOKEN_KEY,
  type NativeSecureStore,
} from "./secure-store.ts";

/** A stand-in for the platform keystore, in the shape the real one has. */
function fakeNative(overrides: Partial<NativeSecureStore> = {}): NativeSecureStore {
  const stored = new Map<string, string>();
  return {
    getItemAsync: (key) => Promise.resolve(stored.get(key) ?? null),
    setItemAsync: (key, value) => {
      stored.set(key, value);
      return Promise.resolve();
    },
    deleteItemAsync: (key) => {
      stored.delete(key);
      return Promise.resolve();
    },
    ...overrides,
  };
}

describe("the keystore adapter", () => {
  it("stores a secret and gives it back", async () => {
    const store = nativeSecretStore(fakeNative());

    await store.write(SESSION_TOKEN_KEY, "a-very-secret-token");

    assert.equal(await store.read(SESSION_TOKEN_KEY), "a-very-secret-token");
  });

  it("says undefined rather than null when there is nothing stored", async () => {
    // One way to say "nothing", the same translation the SQLite adapter makes
    // for a missing row.
    assert.equal(await nativeSecretStore(fakeNative()).read(SESSION_TOKEN_KEY), undefined);
  });

  it("forgets a secret, and forgetting twice is not an error", async () => {
    const store = nativeSecretStore(fakeNative());
    await store.write(SESSION_TOKEN_KEY, "token");

    await store.forget(SESSION_TOKEN_KEY);
    await store.forget(SESSION_TOKEN_KEY);

    assert.equal(await store.read(SESSION_TOKEN_KEY), undefined);
  });

  it("replaces what was there, so a new login does not leave the old token", async () => {
    const store = nativeSecretStore(fakeNative());

    await store.write(SESSION_TOKEN_KEY, "first");
    await store.write(SESSION_TOKEN_KEY, "second");

    assert.equal(await store.read(SESSION_TOKEN_KEY), "second");
  });

  describe("when the platform fails", () => {
    const failing = (method: keyof NativeSecureStore) =>
      nativeSecretStore(
        fakeNative({ [method]: () => Promise.reject(new Error("keystore unavailable")) }),
      );

    it("reports a read failure as its own error", async () => {
      await assert.rejects(
        () => failing("getItemAsync").read(SESSION_TOKEN_KEY),
        (error: unknown) => error instanceof SecretStoreError && error.key === SESSION_TOKEN_KEY,
      );
    });

    it("reports a write failure as its own error", async () => {
      await assert.rejects(
        () => failing("setItemAsync").write(SESSION_TOKEN_KEY, "token"),
        (error: unknown) => error instanceof SecretStoreError,
      );
    });

    it("reports a clear failure as its own error", async () => {
      await assert.rejects(
        () => failing("deleteItemAsync").forget(SESSION_TOKEN_KEY),
        (error: unknown) => error instanceof SecretStoreError,
      );
    });

    it("never puts the secret in the error", async () => {
      const store = nativeSecretStore(
        fakeNative({ setItemAsync: () => Promise.reject(new Error("keystore unavailable")) }),
      );

      // An error that reached a log carrying the token would defeat the point
      // of keeping it in the keystore at all.
      const error = await store
        .write(SESSION_TOKEN_KEY, "a-very-secret-token")
        .then(() => undefined, (caught: unknown) => caught);
      assert.ok(error instanceof SecretStoreError);
      assert.equal(JSON.stringify({ message: error.message, key: error.key }).includes("a-very-secret-token"), false);
    });

    it("keeps the cause, so the platform's reason is not lost", async () => {
      const reason = new Error("user has no screen lock");
      const store = nativeSecretStore(fakeNative({ setItemAsync: () => Promise.reject(reason) }));

      await assert.rejects(
        () => store.write(SESSION_TOKEN_KEY, "token"),
        (error: unknown) => error instanceof SecretStoreError && error.cause === reason,
      );
    });
  });
});

describe("the in-memory store tests use", () => {
  it("behaves the way the adapter does", async () => {
    const store = memorySecretStore();

    assert.equal(await store.read("k"), undefined);
    await store.write("k", "v");
    assert.equal(await store.read("k"), "v");
    await store.forget("k");
    assert.equal(await store.read("k"), undefined);
    assert.equal(store.size(), 0);
  });
});
