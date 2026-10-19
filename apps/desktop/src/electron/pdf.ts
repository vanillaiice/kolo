import { BrowserWindow, session } from "electron";

/** Its own in-memory session, so the printing page shares no cookies, storage or permissions with the shop window. */
const PARTITION = "kolo-pdf";
let guarded = false;

/**
 * Renders a self-contained HTML page (a report from core `reportHtml`) to A4 PDF bytes in a hidden window that runs no
 * script, has no preload and may load nothing but the page itself. The window is destroyed whatever happens.
 */
export async function renderPdf(html: string): Promise<Uint8Array> {
  const printing = session.fromPartition(PARTITION);
  if (!guarded) {
    printing.webRequest.onBeforeRequest((details, respond) => respond({ cancel: !details.url.startsWith("data:text/html") }));
    printing.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    guarded = true;
  }
  const window = new BrowserWindow({ show: false, width: 794, height: 1123,
    webPreferences: { session: printing, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false } });
  try {
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return new Uint8Array(await window.webContents.printToPDF({ pageSize: "A4", printBackground: true, preferCSSPageSize: true }));
  } finally { window.destroy(); }
}
