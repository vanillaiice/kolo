/** Validate the actual Electron/OS credential adapter in disposable user data. */
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const runtime = require("electron");
const directory = mkdtempSync(join(tmpdir(), "kolo-native-credentials-"));
mkdirSync(join(directory, "user-data"));
const entry = join(directory, "credential-smoke.cjs");
const coreModule = relative => pathToFileURL(resolve("packages/core/dist", relative)).href;
const adapter = pathToFileURL(resolve("apps/desktop/dist/electron/local-credentials.js")).href;
writeFileSync(entry, `
const { app, safeStorage } = require("electron");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { readFile, readdir } = require("node:fs/promises");
const { randomUUIDv7 } = require("node:crypto");
app.setName("KOLO credential validation");
app.setPath("userData", ${JSON.stringify(join(directory, "user-data"))});
void app.whenReady().then(async () => {
  try {
    const { localCredentialsOnDesktop, desktopTransferCrypto } = await import(${JSON.stringify(adapter)});
    const vault = join(app.getPath("userData"), "credentials");
    const request = { installationId: randomUUIDv7(), businessId: randomUUIDv7(), userId: randomUUIDv7(), deviceId: randomUUIDv7(), secret: "654321" };
    const credentials = localCredentialsOnDesktop(vault, safeStorage);
    const available = await safeStorage.isAsyncEncryptionAvailable();
    const backend = process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : process.platform;
    if (!available || ["basic_text", "unknown"].includes(backend)) {
      await assert.rejects(credentials.provision(request));
      process.stdout.write("Protected OS storage unavailable; adapter correctly refused provisioning. Native acceptance remains pending.\\n");
      app.exit(2); return;
    }
    const material = await credentials.provision(request);
    const reopened = localCredentialsOnDesktop(vault, safeStorage);
    assert.equal(await reopened.verify(material.credentialReference, request.secret), true);
    assert.equal(await reopened.verify(material.credentialReference, "765432"), false);
    assert.deepEqual(await reopened.inspect(request.installationId), material);
    for (const file of await readdir(vault)) {
      const encrypted = await readFile(join(vault, file));
      assert.equal(encrypted.includes(Buffer.from(request.secret)), false);
      assert.equal(encrypted.includes(Buffer.from("BEGIN PRIVATE KEY")), false);
    }
    const { nodeWorkspaceFiles } = await import(${JSON.stringify(coreModule("data/database/node-sqlite.js"))});
    const { migrate } = await import(${JSON.stringify(coreModule("data/database/migrations.js"))});
    const { createWorkspace, unlockWorkspace } = await import(${JSON.stringify(coreModule("identity/workspace.js"))});
    const { createBackup, previewBackup, restoreWorkspace } = await import(${JSON.stringify(coreModule("application/backup.js"))});
    const { saveProduct, completeSale } = await import(${JSON.stringify(coreModule("application/operations.js"))});
    const sourceFiles=nodeWorkspaceFiles(join(app.getPath("userData"),"source")),targetFiles=nodeWorkspaceFiles(join(app.getPath("userData"),"target"));
    const source=sourceFiles.openActive(),target=targetFiles.openActive();migrate(source);migrate(target);
    const ports=db=>({database:db,credentials:reopened,newId:randomUUIDv7,now:()=>new Date().toISOString()});
    const install=await createWorkspace({businessName:"Native backup validation",ownerName:"Owner",currency:"XAF",deviceLabel:"A",platform:"DESKTOP",secret:request.secret},ports(source));
    const actor=await unlockWorkspace({userId:install.ownerId,secret:request.secret},ports(source)),productId=randomUUIDv7(),at=new Date().toISOString();
    saveProduct(actor,{id:productId,name:"Rice",unit:"bag",active:true,divisible:false,sellingPriceMinor:500,currency:"XAF",taxRateBasisPoints:0,minimumStock:0,createdAt:at,updatedAt:at});
    const encrypted=await createBackup(actor,"native portable password",sourceFiles,desktopTransferCrypto);
    assert.equal(Buffer.from(encrypted.bytes).includes("Native backup validation"),false);assert.ok(encrypted.filename.endsWith(".kolo-backup"));
    const preview=await previewBackup(encrypted.bytes,"native portable password",targetFiles,desktopTransferCrypto);
    const restored=await restoreWorkspace(preview,{confirmedBusinessId:install.businessId,deviceLabel:"B",platform:"DESKTOP",secret:request.secret},ports(target));
    assert.notEqual(restored.installation.deviceId,install.deviceId);assert.notEqual(restored.installation.publicKey,install.publicKey);
    const restoredActor=await unlockWorkspace({userId:install.ownerId,secret:request.secret},ports(restored.database));
    completeSale(restoredActor,{id:randomUUIDv7(),number:randomUUIDv7(),eventId:randomUUIDv7(),occurredAt:at,lines:[{id:randomUUIDv7(),movementId:randomUUIDv7(),productId,name:"Rice",unitPriceMinor:500,quantity:1000}],payments:[{id:randomUUIDv7(),accountId:String(restored.database.get("SELECT id FROM financial_accounts LIMIT 1").id),amountMinor:500}]});
    assert.equal(restored.database.get("SELECT origin_sequence FROM event_journal WHERE origin_device_id=?",[restored.installation.deviceId]).origin_sequence,1);
    restored.database.close();source.close();target.close();sourceFiles.close();targetFiles.close();
    process.stdout.write("Actual Electron/OS vault encrypted backup, fresh restore and new sale passed.\\n");
    process.stdout.write("Actual Electron crypto/OS vault provisioning, reopen, credential verification and encrypted files passed.\\n");
    app.quit();
  } catch {
    process.stderr.write("Native credential validation failed; no credentials logged.\\n"); app.exit(1);
  }
});
`);
const child = spawn(runtime, [entry], { stdio: "inherit" });
const timer = setTimeout(() => { process.stderr.write("Native credential validation timed out\n"); child.kill("SIGTERM"); }, 30000);
child.once("error", () => { process.stderr.write("Electron could not start\n"); });
child.once("close", code => {
  clearTimeout(timer); rmSync(directory, { recursive: true, force: true }); process.exitCode = code ?? 1;
});
