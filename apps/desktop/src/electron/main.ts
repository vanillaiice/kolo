import { app, BrowserWindow, dialog, ipcMain, powerMonitor, safeStorage, type IpcMainInvokeEvent } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { desktopStatus } from "./database.js";
import { DesktopApplication } from "./application.js";
import { desktopHandlers } from "./handlers.js";
import { localCredentialsOnDesktop, desktopExchangeCrypto, desktopTransferCrypto } from "./local-credentials.js";
import { pickDesktopTransferFile, saveDesktopTransferFile } from "./transfer-files.js";
import type { TransferDialogs } from "./transfer.js";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import type { Database } from "@kolo/core/data/database/driver";

const smokeTest = process.argv.includes("--smoke-test");
const workflowSmoke = process.argv.includes("--workflow-smoke");
if (smokeTest || workflowSmoke) {
  const temporaryDirectory = process.env["KOLO_DESKTOP_SMOKE_DIR"];
  if (temporaryDirectory === undefined) throw new Error("smoke test requires a disposable user-data directory");
  app.setPath("userData", temporaryDirectory);
}

if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  let window: BrowserWindow | undefined;
  let database: Database | undefined;
  let fileSlots: ReturnType<typeof nodeWorkspaceFiles> | undefined;
  let application: DesktopApplication | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let closing = false, closed = false;
  const stop = async (): Promise<void> => {
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
      fileSlots = nodeWorkspaceFiles(app.getPath("userData")); database = fileSlots.openActive(); migrate(database);
      const slots = fileSlots, credentials = localCredentialsOnDesktop(join(app.getPath("userData"), "credentials"), safeStorage);
      const dialogs: TransferDialogs = workflowSmoke ? (await import("./workflow-smoke.js")).smokeDialogs() : {
        open: () => pickDesktopTransferFile(dialog), save: document => saveDesktopTransferFile(document, dialog) };
      // Restore and pairing activate a new database: a new application serves it, and the old one
      // is disposed after its in-flight command (the activation itself) has answered.
      const serve = async (next: Database): Promise<DesktopApplication> => {
        const created = new DesktopApplication({ database: next, credentials, newId: randomUUIDv7, now: () => new Date().toISOString() }, desktopExchangeCrypto,
          { files: slots, dialogs, crypto: desktopTransferCrypto, onActivated: async activated => {
            migrate(activated); const previous = application, previousDatabase = database;
            application = await serve(activated); database = activated;
            void previous?.dispose().finally(() => previousDatabase?.close());
            if (window !== undefined && !window.isDestroyed()) window.webContents.send("kolo:changed");
          } });
        await created.initialize();
        created.onChanged(() => { if (created === application && window !== undefined && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("kolo:changed"); });
        return created;
      };
      application = await serve(database);
      const rendererPath = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
      const rendererUrl = pathToFileURL(rendererPath).href;
      const trusted = (candidate: unknown): boolean => {
        const event = candidate as IpcMainInvokeEvent;
        return window !== undefined && !window.isDestroyed() && event.sender === window.webContents &&
          event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === rendererUrl;
      };
      for (const [channel, handler] of Object.entries(desktopHandlers(() => application!, () => desktopStatus(database!), trusted))) ipcMain.handle(channel, handler);
      window = new BrowserWindow({ width: 1280, height: 850, minWidth: 880, minHeight: 620, backgroundColor: "#f6f5ef",
        webPreferences: { preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false } });
      const lock = (): void => { void application?.lock(); };
      window.on("minimize", lock);
      powerMonitor.on("suspend", lock); powerMonitor.on("lock-screen", lock);
      window.webContents.on("render-process-gone", lock);
      window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) lock(); });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-attach-webview", event => event.preventDefault());
      window.webContents.on("will-navigate", event => event.preventDefault());
      interval = setInterval(() => { void application?.seal(); }, 3000);
      await window.loadFile(rendererPath);
      if (workflowSmoke) {
        const { runDesktopWorkflowSmoke } = await import("./workflow-smoke.js");
        await runDesktopWorkflowSmoke(window, process.env["KOLO_DESKTOP_SMOKE_PHASE"] ?? "create");
        app.quit();
      } else if (smokeTest) {
        const status: unknown = await window.webContents.executeJavaScript("window.kolo.getStatus()");
        if (typeof status !== "object" || status === null || !("shopName" in status) || status.shopName !== null) throw new Error("desktop boot/IPC status failed");
        process.stdout.write("Desktop runtime boot, SQLite and preload IPC passed\n"); app.quit();
      }
    } catch (error) {
      if (smokeTest || workflowSmoke) {
        // Smoke runs use disposable fixtures only, so the failure detail is safe to print.
        process.stderr.write(`Desktop runtime smoke failed: ${error instanceof Error ? error.message : "unknown"}\n`); await stop(); closed = true; app.exit(1); return;
      }
      dialog.showErrorBox("KOLO", "La caisse ne peut pas démarrer. Vos données restent sur cet appareil.");
      await stop(); closed = true; app.quit();
    }
  });
}
