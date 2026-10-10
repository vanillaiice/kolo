import { fileURLToPath } from "node:url";
import { posix, win32 } from "node:path";

/**
 * Whether a frame URL loads exactly the packaged renderer file.
 *
 * Compares decoded file paths rather than URL strings: Chromium and Node percent-encode
 * different characters (Node writes `~` as `%7E`, so 8.3 short paths such as
 * `C:\Users\RUNNER~1\…` never matched). Query strings, fragments and other schemes are
 * refused. Windows paths compare case-insensitively, like the file system.
 */
export function isRendererUrl(candidate: string | undefined, rendererPath: string, windows = process.platform === "win32"): boolean {
  if (candidate === undefined) return false;
  let url: URL;
  try { url = new URL(candidate); } catch { return false; }
  if (url.protocol !== "file:" || url.search !== "" || url.hash !== "") return false;
  let path: string;
  try { path = fileURLToPath(url, { windows }); } catch { return false; }
  const normalize = windows ? (value: string) => win32.normalize(value).toLowerCase() : posix.normalize;
  return normalize(path) === normalize(rendererPath);
}
