import { Linking } from "react-native";
import { runPlatformCheck, type PlatformCheck } from "@kolo/core/application/platform-check";
import { sealingCryptoOnDevice } from "./auth/local-credentials-on-device.ts";

/** Opening this link runs the check and logs one `KOLO_SELF_CHECK` line (scripts/verify-android.mjs, over adb). */
export const SELF_CHECK_URL = "kolo://self-check";

/**
 * Runs the shared platform check with this phone's adapters: Hermes, quick-crypto's OpenSSL and its key imports.
 * Node tests cannot prove these; an installed build can. Uses public test vectors only; touches no shop data.
 */
export function checkThisDevice(): Promise<PlatformCheck> { return runPlatformCheck(sealingCryptoOnDevice, sealingCryptoOnDevice); }

/** Answers `kolo://self-check` at launch or while running; returns the unsubscribe. */
export function listenForSelfCheck(): () => void {
  const run = (url: string | null): void => {
    if (url !== SELF_CHECK_URL) return;
    void checkThisDevice().then(result => { console.log(`KOLO_SELF_CHECK ${JSON.stringify(result)}`); });
  };
  Linking.getInitialURL().then(run, () => undefined);
  const subscription = Linking.addEventListener("url", event => { run(event.url); });
  return () => { subscription.remove(); };
}
