/**
 * Where the device's keystore enters the application (§37, ADR-012).
 *
 * The counterpart of `database/open-on-device.ts`, and the **only** file that
 * imports `expo-secure-store`. It exists so that the claim "the native secure
 * store has these three methods" is checked on one line: an SDK that renames
 * `setItemAsync` breaks this file with a type error rather than leaving the
 * adapter describing an API that no longer exists.
 */

import * as SecureStore from "expo-secure-store";

import { nativeSecretStore, type SecretStore } from "@kolo/core/data/auth/secure-store";

/** The device's keystore, as the data layer sees it. */
export function secretStoreOnDevice(): SecretStore {
  const options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return nativeSecretStore({
    getItemAsync: key => SecureStore.getItemAsync(key, options),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, options),
    deleteItemAsync: key => SecureStore.deleteItemAsync(key, options),
  });
}
