import { app, BrowserWindow, dialog, ipcMain, powerMonitor, safeStorage, nativeTheme, type IpcMainInvokeEvent } from "electron";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { randomUUIDv7 } from "node:crypto";
import { desktopStatus } from "./database.js";
import { DesktopApplication } from "./application.js";
import { desktopSessionMemory } from "./session-memory.js";
import { desktopHandlers } from "./handlers.js";
import { isRendererUrl } from "./renderer-origin.js";
import { localCredentialsOnDesktop, desktopExchangeCrypto, desktopTransferCrypto } from "./local-credentials.js";
import { pickDesktopTransferFile, saveDesktopTransferFile } from "./transfer-files.js";
import type { TransferDialogs } from "./transfer.js";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { devicePreferences } from "./preferences.js";
import { migrate } from "@kolo/core/data/database/migrations";
import type { Database } from "@kolo/core/data/database/driver";

const smokeTest = process.argv.includes("--smoke-test");
const workflowSmoke = process.argv.includes("--workflow-smoke");
const benchmarkSmoke = process.argv.includes("--benchmark-smoke");
const bootStart = performance.now();
nativeTheme.themeSource = "system";
const windowBackground = (): string => nativeTheme.shouldUseDarkColors ? "#1f2b25" : "#f4f7f3";
if (smokeTest || workflowSmoke || benchmarkSmoke) {
  const temporaryDirectory = process.env["KOLO_DESKTOP_SMOKE_DIR"];
  if (temporaryDirectory === undefined) throw new Error("smoke test requires a disposable user-data directory");
  app.setPath("userData", temporaryDirectory);
} else {
  // Keep the existing shop location across packaged product-name changes, including
  // clean installs where Electron requires the overridden directory to exist first.
  const directory = join(app.getPath("appData"), "@kolo/desktop");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  app.setPath("userData", directory);
}

if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  let window: BrowserWindow | undefined;
  let database: Database | undefined;
  let fileSlots: ReturnType<typeof nodeWorkspaceFiles> | undefined;
  let application: DesktopApplication | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let closing = false, closed = false;
  const stop = async (): Promise<void> => {
    closing = true;
    if (interval !== undefined) clearInterval(interval);
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
    void stop().finally(() => { closed = true; app.quit(); });
  });

  void app.whenReady().then(async () => {
    try {
      // Per-computer settings live beside, never inside, the business database.
      const preferences = devicePreferences(join(app.getPath("userData"), "preferences.json"));
      fileSlots = nodeWorkspaceFiles(app.getPath("userData"), { limits: preferences.limits }); database = fileSlots.openActive(); migrate(database);
      const credentials = localCredentialsOnDesktop(join(app.getPath("userData"), "credentials"), safeStorage);
      const memory = desktopSessionMemory(join(app.getPath("userData"), "session"), safeStorage);
      const dialogs: TransferDialogs = workflowSmoke ? (await import("./workflow-smoke.js")).smokeDialogs() : {
        open: () => pickDesktopTransferFile(dialog, preferences.limits().fileBytes), save: document => saveDesktopTransferFile(document, dialog, preferences.limits().fileBytes) };
      // Restore and pairing activate a new database: a new application serves it, and the old one
      // is disposed after its in-flight command (the activation itself) has answered.
      // Computer reset: after the command answered, retire the application, delete every shop file,
      // credential and remembered session in user data (preferences stay), then serve a fresh empty shop.
      const resetComputer = async (): Promise<void> => {
        const previous = application, previousDatabase = database;
        await previous?.dispose(); previousDatabase?.close(); fileSlots?.close();
        const data = app.getPath("userData");
        for (const entry of readdirSync(data)) if (/^(kolo\.db|workspace-[0-9a-f-]+\.db|stage-[0-9a-f-]+\.db|workspace-slots\.db)(?:-wal|-shm|-journal)?$/.test(entry)) rmSync(join(data, entry), { force: true });
        for (const directory of ["credentials", "session"]) rmSync(join(data, directory), { recursive: true, force: true });
        fileSlots = nodeWorkspaceFiles(data, { limits: preferences.limits });
        const fresh = fileSlots.openActive(); migrate(fresh);
        application = await serve(fresh); database = fresh;
        if (window !== undefined && !window.isDestroyed()) window.webContents.send("kolo:changed");
      };
      const serve = async (next: Database): Promise<DesktopApplication> => {
        const created = new DesktopApplication({ database: next, credentials, newId: randomUUIDv7, now: () => new Date().toISOString() }, desktopExchangeCrypto,
          { files: fileSlots!, dialogs, crypto: desktopTransferCrypto, onReset: () => { setImmediate(() => { void resetComputer(); }); }, onActivated: async activated => {
            migrate(activated); const previous = application, previousDatabase = database;
            application = await serve(activated); database = activated;
            void previous?.dispose().finally(() => previousDatabase?.close());
            if (window !== undefined && !window.isDestroyed()) window.webContents.send("kolo:changed");
          } }, memory, preferences);
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
      window = new BrowserWindow({ width: 1280, height: 850, minWidth: 880, minHeight: 620, backgroundColor: windowBackground(),
        webPreferences: { preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false } });
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
      loaded = true;
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
