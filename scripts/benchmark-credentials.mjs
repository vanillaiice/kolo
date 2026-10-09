/** Run on each supported desktop OS; output is measurement metadata, never secrets/verifiers. */
import { performance } from "node:perf_hooks";
import { platform, arch, cpus } from "node:os";
import { desktopCredentialCrypto } from "../apps/desktop/src/electron/local-credentials.ts";
import { CREDENTIAL_ITERATIONS } from "@kolo/core/identity/credentials";
const durations = [];
for (let index = 0; index < 5; index++) {
  const started = performance.now();
  await desktopCredentialCrypto.derive("benchmark-only", desktopCredentialCrypto.randomHex(16), CREDENTIAL_ITERATIONS);
  durations.push(Number((performance.now() - started).toFixed(2)));
}
const sorted = [...durations].sort((a, b) => a - b);
process.stdout.write(`${JSON.stringify({ platform: platform(), architecture: arch(), cpu: cpus()[0]?.model,
  node: process.version, algorithm: "PBKDF2-HMAC-SHA256", iterations: CREDENTIAL_ITERATIONS,
  samples_ms: durations, median_ms: sorted[2], native_os_storage_tested: false }, null, 2)}\n`);
