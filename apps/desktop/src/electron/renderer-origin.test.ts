import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { isRendererUrl } from "./renderer-origin.ts";

const windowsRenderer = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\kolo-install\\resources\\app.asar\\dist\\renderer\\index.html";
const posixRenderer = "/opt/KOLO/resources/app.asar/dist/renderer/index.html";

test("a short-name Windows path matches however the tilde and drive are encoded", () => {
  for (const url of [
    "file:///C:/Users/RUNNER~1/AppData/Local/Temp/kolo-install/resources/app.asar/dist/renderer/index.html",
    "file:///C:/Users/RUNNER%7E1/AppData/Local/Temp/kolo-install/resources/app.asar/dist/renderer/index.html",
    "file:///c:/users/runner~1/appdata/local/temp/kolo-install/resources/app.asar/dist/renderer/index.html",
    pathToFileURL(windowsRenderer, { windows: true }).href,
  ]) assert.equal(isRendererUrl(url, windowsRenderer, true), true, url);
});

test("spaces and non-ASCII names match on both platforms", () => {
  const windows = "C:\\Users\\Amina Ngo Bé\\AppData\\Local\\Programs\\KOLO\\resources\\app.asar\\dist\\renderer\\index.html";
  assert.equal(isRendererUrl("file:///C:/Users/Amina%20Ngo%20B%C3%A9/AppData/Local/Programs/KOLO/resources/app.asar/dist/renderer/index.html", windows, true), true);
  const posix = "/home/amina bé/KOLO/index.html";
  assert.equal(isRendererUrl(pathToFileURL(posix, { windows: false }).href, posix, false), true);
});

test("posix paths stay case-sensitive", () => {
  assert.equal(isRendererUrl(pathToFileURL(posixRenderer, { windows: false }).href, posixRenderer, false), true);
  assert.equal(isRendererUrl(pathToFileURL(posixRenderer.toUpperCase(), { windows: false }).href, posixRenderer, false), false);
});

test("other files, schemes, queries, fragments and malformed input are refused", () => {
  const good = pathToFileURL(posixRenderer, { windows: false }).href;
  for (const url of [
    undefined, "", "not a url", "about:blank", "https://example.com/index.html",
    "file:///opt/KOLO/resources/app.asar/dist/renderer/other.html",
    "file:///opt/KOLO/resources/app.asar/dist/renderer/index.html.evil",
    `${good}?x=1`, `${good}#/sell`, "file:///opt/KOLO/%2F..%2Findex.html",
  ]) assert.equal(isRendererUrl(url, posixRenderer, false), false, String(url));
  assert.equal(isRendererUrl("file:///D:/Users/RUNNER~1/AppData/Local/Temp/kolo-install/resources/app.asar/dist/renderer/index.html", windowsRenderer, true), false);
});

test("dot segments resolve to the same file only when they really do", () => {
  assert.equal(isRendererUrl("file:///opt/KOLO/resources/app.asar/dist/x/../renderer/index.html", posixRenderer, false), true);
  assert.equal(isRendererUrl("file:///opt/KOLO/resources/app.asar/dist/renderer/../index.html", posixRenderer, false), false);
});
