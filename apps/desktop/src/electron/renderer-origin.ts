import { extname, isAbsolute, join, relative, sep } from "node:path";

/**
 * The renderer is served from its own privileged scheme rather than `file://`: on a `file://` page a CSP `'self'`
 * also matches every other local file, while here it matches only the packaged renderer directory.
 */
export const RENDERER_SCHEME = "kolo-app";
const HOST = "renderer";
/** The one page the window loads and the only frame trusted to call the command bridge. */
export const RENDERER_URL = `${RENDERER_SCHEME}://${HOST}/index.html`;
/** What the renderer build contains; anything else is refused rather than guessed. */
export const RENDERER_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

/** Whether a frame URL is exactly the renderer page: same scheme and host, `/index.html`, no query or fragment. */
export function isRendererUrl(candidate: string | undefined): boolean {
  if (candidate === undefined) return false;
  let url: URL;
  try { url = new URL(candidate); } catch { return false; }
  return url.protocol === `${RENDERER_SCHEME}:` && url.host === HOST && url.pathname === "/index.html" && url.search === "" && url.hash === "" && url.username === "" && url.port === "";
}

/**
 * The renderer file a request names, or undefined: wrong scheme or host, a query, an encoded separator, a path that
 * leaves the renderer directory, or a file type the build never contains.
 */
export function rendererFile(requestUrl: string, root: string): { readonly path: string; readonly type: string } | undefined {
  let url: URL;
  try { url = new URL(requestUrl); } catch { return undefined; }
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.host !== HOST || url.search !== "" || url.username !== "" || url.port !== "") return undefined;
  let name: string;
  try { name = decodeURIComponent(url.pathname); } catch { return undefined; }
  if (name.includes("\0") || name.includes("\\") || /%2f|%5c/i.test(url.pathname)) return undefined;
  const path = join(root, ...name.split("/").filter(part => part !== "")), inside = relative(root, path);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside) || inside.split(sep).includes("..")) return undefined;
  const type = RENDERER_TYPES[extname(path).toLowerCase()];
  return type === undefined ? undefined : { path, type };
}
