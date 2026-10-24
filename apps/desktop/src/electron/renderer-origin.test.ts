import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { isRendererUrl, rendererFile, RENDERER_URL } from "./renderer-origin.ts";

const root = join("/opt", "KOLO", "resources", "app.asar", "dist", "renderer");

test("only the renderer page itself is trusted to call the bridge", () => {
  assert.equal(isRendererUrl(RENDERER_URL), true);
  for (const url of [
    undefined, "", "not a url", "about:blank", "https://example.com/index.html", "file:///opt/KOLO/resources/app.asar/dist/renderer/index.html",
    "kolo-app://renderer/other.html", "kolo-app://renderer/index.html.evil", "kolo-app://renderer/index.html?x=1", "kolo-app://renderer/index.html#/sell",
    "kolo-app://other/index.html", "kolo-app://user@renderer/index.html", "kolo-app://renderer:8080/index.html", "kolo-app://renderer/assets/../index.html.x",
  ]) assert.equal(isRendererUrl(url), false, String(url));
});

test("the protocol serves files inside the renderer directory with their known type", () => {
  assert.deepEqual(rendererFile(RENDERER_URL, root), { path: join(root, "index.html"), type: "text/html; charset=utf-8" });
  assert.deepEqual(rendererFile("kolo-app://renderer/assets/index-Ab12.js", root), { path: join(root, "assets", "index-Ab12.js"), type: "text/javascript; charset=utf-8" });
  assert.deepEqual(rendererFile("kolo-app://renderer/assets/inter%20latin.woff2", root), { path: join(root, "assets", "inter latin.woff2"), type: "font/woff2" });
  assert.deepEqual(rendererFile("kolo-app://renderer/assets/x/../app.css", root), { path: join(root, "assets", "app.css"), type: "text/css; charset=utf-8" });
  // URL parsing resolves dot segments before the request arrives: they can never climb above the renderer directory.
  for (const url of ["kolo-app://renderer/../../outside.js", "kolo-app://renderer/%2e%2e/%2e%2e/outside.js"]) assert.equal(rendererFile(url, root)?.path, join(root, "outside.js"), url);
});

test("nothing outside the renderer directory, of an unknown type, or oddly addressed is served", () => {
  for (const url of [
    "kolo-app://renderer/..%2f..%2fetc%2fpasswd", "kolo-app://renderer/../../app.asar/package.json",
    "kolo-app://renderer/assets%5c..%5c..%5cx.js", "kolo-app://renderer/a%00.js", "kolo-app://renderer/", "kolo-app://renderer",
    "kolo-app://renderer/database.sqlite", "kolo-app://renderer/assets/app.js.map", "kolo-app://renderer/index.html?x=1", "kolo-app://other/index.html",
    "file:///opt/KOLO/resources/app.asar/dist/renderer/index.html", "kolo-app://renderer/%E0%A4%A.js", "not a url",
  ]) assert.equal(rendererFile(url, root), undefined, url);
});
