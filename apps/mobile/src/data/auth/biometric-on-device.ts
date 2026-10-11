import * as SecureStore from "expo-secure-store";
import type { BiometricVault } from "./biometric-unlock.ts";

/**
 * Keystore entries bound to the phone's strong biometrics. Android encrypts each with a key that
 * opens only after the system fingerprint or face check and is invalidated when the enrolled
 * fingerprints change; nothing is backed up or leaves this device.
 */
export function biometricVaultOnDevice(): BiometricVault {
  const options = (prompt?: string): SecureStore.SecureStoreOptions => ({ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY, requireAuthentication: true,
    ...(prompt === undefined ? {} : { authenticationPrompt: prompt }) });
  return {
    available: () => SecureStore.canUseBiometricAuthentication(),
    save: (key, value) => SecureStore.setItemAsync(key, value, options()),
    load: async (key, prompt) => (await SecureStore.getItemAsync(key, options(prompt))) ?? undefined,
    forget: key => SecureStore.deleteItemAsync(key, options()),
  };
}
