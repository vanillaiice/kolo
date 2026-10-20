import { app, BrowserWindow, dialog, ipcMain, powerMonitor, safeStorage, nativeTheme, shell, type IpcMainInvokeEvent } from "electron";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "node:crypto";
import { desktopStatus } from "./database.js";
import { DesktopApplication } from "./application.js";
import { desktopSessionMemory } from "./session-memory.js";
import { desktopHandlers } from "./handlers.js";
import { isRendererUrl } from "./renderer-origin.js";
import { localCredentialsOnDesktop, desktopSealingCrypto } from "./local-credentials.js";
import { clearOutgoing, pickDesktopTransferFile, saveDesktopExportFile, saveDesktopPdfFile, saveDesktopTransferFile, saveDesktopTransferStream } from "./transfer-files.js";
import { renderPdf } from "./pdf.js";
import { DesktopUpdates, installKind, updateHandlers, writeSafetyCopy, type Updater } from "./updates.js";
import type { TransferDialogs } from "./transfer.js";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import type { Database } from "@kolo/core/data/database/driver";

const smokeTest = process.argv.includes("--smoke-test");
const workflowSmoke = process.argv.includes("--workflow-smoke");
// The packaged build checks its own runtime and exits (scripts/verify-desktop-build.mjs); it never touches shop data.
const selfCheck = process.argv.includes("--self-check");
const benchmarkSmoke = process.argv.includes("--benchmark-smoke");
const bootStart = performance.now();
nativeTheme.themeSource = "system";
const windowBackground = (): string => nativeTheme.shouldUseDarkColors ? "#1f2b25" : "#f4f7f3";
if (smokeTest || workflowSmoke || benchmarkSmoke) {
  const temporaryDirectory = process.env["KOLO_DESKTOP_SMOKE_DIR"];
  if (temporaryDirectory === undefined) throw new Error("smoke test requires a disposable user-data directory");
  app.setPath("userData", temporaryDirectory);
} else if (selfCheck) {
  app.setPath("userData", mkdtempSync(join(tmpdir(), "kolo-self-check-data-")));
} else {
  // Keep the existing shop location across packaged product-name changes, including
  // clean installs where Electron requires the overridden directory to exist first.
  const directory = join(app.getPath("appData"), "@kolo/desktop");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  app.setPath("userData", directory);
}

if (selfCheck) {
  void app.whenReady().then(async () => {
    const result = await (await import("./self-check.js")).desktopSelfCheck(app.isPackaged ? process.resourcesPath : undefined);
    process.stdout.write(`KOLO_SELF_CHECK ${JSON.stringify(result)}\n`);
    // A GUI app's stdout can be lost (Windows, wine): the verifier names a file for the result instead.
    const output = process.env["KOLO_SELF_CHECK_OUTPUT"];
    if (output !== undefined) writeFileSync(output, JSON.stringify(result));
    // Chromium still holds files in its user data on Windows: removing it is best effort and never delays the exit.
    try { rmSync(app.getPath("userData"), { recursive: true, force: true }); } catch { /* Left in the OS temporary directory. */ }
    app.exit(result.ok ? 0 : 1);
  }).catch(() => { app.exit(1); });
} else if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  let window: BrowserWindow | undefined;
  let database: Database | undefined;
  let fileSlots: ReturnType<typeof nodeWorkspaceFiles> | undefined;
  let application: DesktopApplication | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let updates: DesktopUpdates | undefined;
  let closing = false, closed = false;
  const stop = async (): Promise<void> => {
    closing = true;
    if (interval !== undefined) clearInterval(interval);
    updates?.dispose();
    await application?.dispose(); application = undefined;
    database?.close(); database = undefined; fileSlots?.close(); fileSlots = undefined;
  };
  app.on("second-instance", () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", event => {
    if (closed) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    // An update installing on close copies the shop first, while its database is still open.
    void (updates?.beforeQuit() ?? Promise.resolve()).then(stop).finally(() => { closed = true; app.quit(); });
  });

  void app.whenReady().then(async () => {
    try {
      fileSlots = nodeWorkspaceFiles(app.getPath("userData")); database = fileSlots.openActive(); migrate(database);
      const credentials = localCredentialsOnDesktop(join(app.getPath("userData"), "credentials"), safeStorage);
      const memory = desktopSessionMemory(join(app.getPath("userData"), "session"), safeStorage);
      // Backups stream through a private outgoing directory before the owner chooses where to keep them (ADR-035).
      const outgoing = join(app.getPath("userData"), "outgoing"); clearOutgoing(outgoing);
      const dialogs: TransferDialogs = workflowSmoke ? (await import("./workflow-smoke.js")).smokeDialogs(outgoing) : {
        open: () => pickDesktopTransferFile(dialog), save: document => saveDesktopTransferFile(document, dialog),
        saveStream: write => saveDesktopTransferStream(write, dialog, outgoing), saveExport: (filename, bytes) => saveDesktopExportFile(filename, bytes, dialog),
        savePdf: async (filename, html) => saveDesktopPdfFile(filename, await renderPdf(html), dialog) };
      // Restore and pairing activate a new database: a new application serves it, and the old one
      // is disposed after its in-flight command (the activation itself) has answered.
      // Computer reset: after the command answered, retire the application, delete every shop file,
      // credential and remembered session in user data (preferences stay), then serve a fresh empty shop.
      const resetComputer = async (): Promise<void> => {
        const previous = application, previousDatabase = database;
        await previous?.dispose(); previousDatabase?.close(); fileSlots?.close();
        const data = app.getPath("userData");
        for (const entry of readdirSync(data)) if (/^(kolo\.db|workspace-[0-9a-f-]+\.db|stage-[0-9a-f-]+\.db|workspace-slots\.db)(?:-wal|-shm|-journal)?$/.test(entry)) rmSync(join(data, entry), { force: true });
        for (const directory of ["credentials", "session", "pre-update"]) rmSync(join(data, directory), { recursive: true, force: true });
        fileSlots = nodeWorkspaceFiles(data);
        const fresh = fileSlots.openActive(); migrate(fresh);
        application = await serve(fresh); database = fresh;
        if (window !== undefined && !window.isDestroyed()) window.webContents.send("kolo:changed");
      };
      const serve = async (next: Database): Promise<DesktopApplication> => {
        const created = new DesktopApplication({ database: next, credentials, newId: randomUUIDv7, now: () => new Date().toISOString() }, desktopSealingCrypto,
          { files: fileSlots!, dialogs, crypto: desktopSealingCrypto, onReset: () => { setImmediate(() => { void resetComputer(); }); }, onActivated: async activated => {
            migrate(activated); const previous = application, previousDatabase = database;
            application = await serve(activated); database = activated;
            void previous?.dispose().finally(() => previousDatabase?.close());
            if (window !== undefined && !window.isDestroyed()) window.webContents.send("kolo:changed");
          } }, memory);
        await created.initialize();
        created.onChanged(() => { if (!closing && created === application && window !== undefined && !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.mainFrame.isDestroyed()) window.webContents.send("kolo:changed"); });
        return created;
      };
      application = await serve(database);
      const rendererPath = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
      const trusted = (candidate: unknown): boolean => {
        const event = candidate as IpcMainInvokeEvent;
        return !closing && window !== undefined && !window.isDestroyed() && event.sender === window.webContents &&
          event.senderFrame === window.webContents.mainFrame && isRendererUrl(event.senderFrame?.url, rendererPath);
      };
      for (const [channel, handler] of Object.entries(desktopHandlers(() => application!, () => desktopStatus(database!), trusted))) ipcMain.handle(channel, handler);
      // Smoke and benchmark runs of a packaged build never look for updates.
      const packageType = ((): string | undefined => { try { return readFileSync(join(process.resourcesPath, "package-type"), "utf8").trim(); } catch { return undefined; } })();
      const kind = smokeTest || workflowSmoke || benchmarkSmoke ? "development" : installKind({ platform: process.platform, packaged: app.isPackaged, windowsStore: process.windowsStore === true, env: process.env, packageType });
      updates = new DesktopUpdates({ kind, currentVersion: app.getVersion(), preferences: join(app.getPath("userData"), "updates.json"), now: () => new Date().toISOString(),
        updater: async (): Promise<Updater> => {
          const { AppImageUpdater, DebUpdater, NsisUpdater } = (await import("electron-updater")).default;
          return kind === "appimage" ? new AppImageUpdater() : kind === "deb" ? new DebUpdater() : new NsisUpdater();
        },
        safetyCopy: async () => { writeSafetyCopy(database!, join(app.getPath("userData"), "pre-update"), app.getVersion(), new Date()); },
        publish: view => { if (!closing && window !== undefined && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("kolo:update", view); },
        beforeInstall: async () => { await stop(); closed = true; },
        afterInstall: started => { if (started) app.quit(); else { app.relaunch(); app.exit(0); } } });
      for (const [channel, handler] of Object.entries(updateHandlers(updates, trusted, () => shell.openExternal("https://github.com/vanillaiice/kolo/releases")))) ipcMain.handle(channel, handler);
      window = new BrowserWindow({ width: 1280, height: 850, minWidth: 880, minHeight: 620, backgroundColor: windowBackground(), show: false,
        webPreferences: { preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, backgroundThrottling: !(workflowSmoke || benchmarkSmoke) } });
      // Shown after the first paint, so the entry screen appears whole instead of an empty frame.
      window.once("ready-to-show", () => { if (window !== undefined && !window.isDestroyed()) window.show(); });
      const updateWindowTheme = (): void => { if (window !== undefined && !window.isDestroyed()) window.setBackgroundColor(windowBackground()); };
      nativeTheme.on("updated", updateWindowTheme);
      window.on("closed", () => nativeTheme.removeListener("updated", updateWindowTheme));
      // Stepping away keeps a user who chose to stay signed in; a lost or navigated renderer always locks.
      const away = (): void => { void application?.autoLock("away"); }, lock = (): void => { void application?.autoLock("integrity"); };
      window.on("minimize", away);
      powerMonitor.on("suspend", away); powerMonitor.on("lock-screen", away);
      window.webContents.on("render-process-gone", lock);
      // The initial renderer load is not a navigation away; any later main-frame navigation or reload locks.
      let loaded = false;
      window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => { if (loaded && isMainFrame && !isInPlace) lock(); });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-attach-webview", event => event.preventDefault());
      window.webContents.on("will-navigate", event => event.preventDefault());
      interval = setInterval(() => { void application?.seal(); }, 3000);
      await window.loadFile(rendererPath);
      if (!window.isVisible()) window.show();
      loaded = true;
      updates.start();
      if (benchmarkSmoke) {
        const { benchmarkDesktop } = await import("./benchmark.js");
        await benchmarkDesktop(window, database, performance.now() - bootStart); app.quit();
      } else if (workflowSmoke) {
        const { runDesktopWorkflowSmoke } = await import("./workflow-smoke.js");
        await runDesktopWorkflowSmoke(window, process.env["KOLO_DESKTOP_SMOKE_PHASE"] ?? "create");
        app.quit();
      } else if (smokeTest) {
        const status: unknown = await window.webContents.executeJavaScript("window.kolo.getStatus()");
        if (typeof status !== "object" || status === null || !("shopName" in status) || status.shopName !== null) throw new Error("desktop boot/IPC status failed");
        process.stdout.write("Desktop runtime boot, SQLite and preload IPC passed\n"); app.quit();
      }
    } catch (error) {
      if (smokeTest || workflowSmoke || benchmarkSmoke) {
        // Smoke runs use disposable fixtures only, so the failure detail is safe to print.
        process.stderr.write(`Desktop runtime smoke failed: ${error instanceof Error ? error.message : "unknown"}\n`); await stop(); closed = true; app.exit(1); return;
      }
      dialog.showErrorBox("KOLO", "La caisse ne peut pas démarrer. Vos données restent sur cet appareil.");
      await stop(); closed = true; app.quit();
    }
  });
}
