/**
 * Where the server is, and nothing else.
 *
 * One constant rather than a URL typed into each caller, because a device
 * talking to two different servers would push its sales to one and pull its
 * catalogue from the other.
 *
 * It comes from the environment at build time. Expo inlines any variable named
 * `EXPO_PUBLIC_*` into the bundle, so a build for a real shop is
 * `EXPO_PUBLIC_API_URL=https://… npx expo export` and nothing in this file
 * changes. The fallback is the development one: `10.0.2.2` is how an Android
 * emulator reaches the host machine, where `cmd/api` listens on 8080.
 *
 * It is **not** a setting a user can change. A field on the login screen for
 * "server address" is a field somebody can be talked into changing, and the
 * thing they would be handing over is the shop's whole book.
 */
export const API_BASE_URL: string =
  process.env["EXPO_PUBLIC_API_URL"] ?? "http://10.0.2.2:8080/api/v1";
