/**
 * Lets the optional sync server be reached over plain HTTP on a shop's own network (ADR-029/030).
 *
 * Android blocks cleartext HTTP in release builds unless the manifest allows it, and its network security
 * configuration can only name domains, not private address ranges. The app keeps the real policy itself:
 * `normalizeServerUrl` refuses http:// except on loopback, `*.local` and private LAN addresses, and every
 * business fact is encrypted and signed before it leaves the phone. The android directory is regenerated
 * by `expo prebuild`, hence a config plugin rather than an edit.
 */
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withLanHttp(config) {
  return withAndroidManifest(config, result => {
    const application = result.modResults.manifest.application?.[0];
    if (application !== undefined) application.$["android:usesCleartextTraffic"] = "true";
    return result;
  });
};
