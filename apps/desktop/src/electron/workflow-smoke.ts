import { basename, join } from "node:path";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { openTransferFile, saveDesktopExportFile, saveDesktopPdfFile, saveDesktopTransferFile, saveDesktopTransferStream } from "./transfer-files.ts";
import { renderPdf } from "./pdf.ts";
import { copyFile, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { nativeTheme, type BrowserWindow, type Dialog, type SaveDialogOptions, type SaveDialogReturnValue } from "electron";
import type { TransferDialogs } from "./transfer.ts";

/**
 * Fixture dialogs: only the OS dialog is replaced. Saves and opens go through the same adapters as the app (a streamed
 * backup into a private temporary file, synced, then copied into a new file; files read in pieces), into the smoke
 * directory. "Open" returns the latest saved file, or the last backup from an earlier phase.
 */
export function smokeDialogs(outgoing: string): TransferDialogs {
  // A caller-supplied file (KOLO_DESKTOP_SMOKE_OPEN_FILE) stands in for the open dialog's choice.
  const supplied = process.env["KOLO_DESKTOP_SMOKE_OPEN_FILE"];
  const directory = process.env["KOLO_DESKTOP_SMOKE_DIR"]!, savedDirectory = join(directory, "saved"), persisted = join(directory, "last.kolo-backup");
  let latest: string | undefined, chosen: string | undefined, count = 0;
  const showSaveDialog = async (options: SaveDialogOptions): Promise<SaveDialogReturnValue> => {
    await mkdir(savedDirectory, { recursive: true });
    chosen = join(savedDirectory, `${++count}-${basename(options.defaultPath!)}`);
    return { canceled: false, filePath: chosen };
  };
  const native = { showSaveDialog } as Pick<Dialog, "showSaveDialog">;
  const keep = async (saved: boolean): Promise<boolean> => {
    if (!saved) return false;
    latest = chosen!; if (latest.endsWith(".kolo-backup")) await copyFile(latest, persisted);
    return true;
  };
  return {
    open: async () => { const path = supplied ?? latest ?? (existsSync(persisted) ? persisted : undefined); return path === undefined ? undefined : openTransferFile(path); },
    save: async document => keep(await saveDesktopTransferFile(document, native)),
    saveStream: async write => keep(await saveDesktopTransferStream(write, native, outgoing)),
    saveExport: async (filename, bytes) => keep(await saveDesktopExportFile(filename, bytes, native)),
    savePdf: async (filename, html) => keep(await saveDesktopPdfFile(filename, await renderPdf(html), native)),
  };
}
/** Disposable actual Electron DOM/IPC/native-vault workflow; invoked only by the explicit smoke flag. */
export async function runDesktopWorkflowSmoke(window: BrowserWindow, phase: string): Promise<void> {
  process.stdout.write(`Desktop workflow phase: ${phase}\n`);
  window.show();window.focus();window.webContents.focus();
  const evaluate = async <T,>(source: string): Promise<T> => {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([window.webContents.executeJavaScript(source) as Promise<T>,new Promise<T>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`Desktop DOM evaluation timed out: ${source.slice(0,80)}`)),15_000);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
  };
  const audit = async (screen: string): Promise<void> => {
    process.stdout.write(`Desktop workflow audit: ${screen}\n`);
    const path = process.env["KOLO_DESKTOP_AXE_PATH"];
    if (path === undefined) throw new Error("Accessibility audit requires the runner's axe-core path");
    await evaluate(await readFile(path, "utf8"));
    const previous = nativeTheme.themeSource;
    try {
      for (const theme of ["light", "dark"] as const) {
        nativeTheme.themeSource = theme;
        await wait(`window.matchMedia('(prefers-color-scheme: dark)').matches===${theme === "dark"}`);
        await evaluate("new Promise(resolve=>{const timer=setTimeout(resolve,100);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));})");
        assert.equal(await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()"), theme === "dark" ? "#1f2b25" : "#f4f7f3", "theme follows native appearance changes");
        // Contrast is checked on the settled screen, not halfway through an entrance fade.
        await wait("document.getAnimations().length===0", "animations settle before the audit");
        const violations = await evaluate(`axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}).then(result=>result.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>({target:node.target,summary:node.failureSummary}))})))`);
        assert.deepEqual(violations, [], `Accessibility audit: ${screen} (${theme}): ${JSON.stringify(violations)}`);
        await snapshot(`${screen.toLowerCase().replace(/[^a-z0-9]+/g,"-")}-${theme}`);
      }
    } finally { nativeTheme.themeSource = previous; }

  };
  const snapshot = async (name: string): Promise<void> => {
    const directory = process.env["KOLO_DESKTOP_SCREENSHOT_DIR"];
    if (directory === undefined) return;
    await evaluate("new Promise(resolve=>{const timer=setTimeout(resolve,100);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));})");
    await wait("document.getAnimations().length===0", "animations settle before the screenshot");
    // Repaint the settled screen, then capture that frame rather than the last one composited.
    window.webContents.invalidate();
    await evaluate("new Promise(resolve=>{const timer=setTimeout(resolve,150);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));})");
    await mkdir(directory, {recursive:true});
    // The first capture after a theme switch can still return the frame presented before it; the second is current.
    await window.webContents.capturePage(); await new Promise(resolve => setTimeout(resolve, 120));
    await writeFile(join(directory, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const wait = async (condition: string, diagnostic = "screen transition"): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const alerts = await evaluate<string>("Array.from(document.querySelectorAll('[role=alert]')).filter(element=>element.offsetParent!==null).map(element=>element.textContent).join(' | ')");
    const message = `Desktop workflow timed out: ${diagnostic}${alerts === "" ? "" : ` (visible alerts: ${alerts})`}\n`;
    process.stderr.write(message);
    // Windows GUI builds (and Wine) may not attach a console; keep the diagnostic in the disposable profile too.
    const directory = process.env["KOLO_DESKTOP_SMOKE_DIR"];
    if (directory !== undefined) await writeFile(join(directory, "workflow-smoke.log"), message, { flag: "a" });
    throw new Error("desktop DOM condition timed out");
  };
  const fill = async (selector: string, value: string): Promise<void> => {
    await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('missing fixture field'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  };
  const click = async (selector: string): Promise<void> => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); };
  const submit = async (selector: string): Promise<void> => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).closest('form').requestSubmit()`); };
  const press = async (scope: string, label: string): Promise<void> => { await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(scope)})).find(element=>element.textContent.trim()===${JSON.stringify(label)}).click()`); };
  // Hidden sections stay mounted to keep drafts, so later sections act on visible elements only.
  const visible = (selector: string): string => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(element=>element.offsetParent!==null)`;
  // Clicks wait for their target to render, since React commits after the previous IPC round trip.
  const clickVisible = async (selector: string, label?: string, parentLabel?: string): Promise<void> => {
    const text = parentLabel === undefined ? "element.textContent.trim()" : "element.parentElement.textContent.trim()", wanted = parentLabel ?? label;
    const match = `${visible(selector)}.find(element=>${wanted === undefined ? "true" : `${text}===${JSON.stringify(wanted)}`})`;
    await wait(`${match}!==undefined`, `click ${selector}${label === undefined ? "" : ` "${label}"`}`); await evaluate(`${match}.click()`);
  };
  const navigate = async (name: string): Promise<void> => { await evaluate(`Array.from(document.querySelectorAll('.nav-item')).find(element=>element.textContent.includes(${JSON.stringify(name)})).click()`); };
  if (phase === "create") {
    await wait("document.querySelector('[data-auth-action=create]')!==null");
    await audit("French welcome choices"); await snapshot("welcome-fr");
    // The bundled Inter face must load from the app itself, not depend on the computer's fonts.
    assert.equal(await evaluate("document.fonts.ready.then(()=>[...document.fonts].some(face=>face.family.replace(/[\"']/g,'')==='Inter Variable'&&face.status==='loaded'))"), true, "bundled Inter font loads");
    // Legal documents open from the entry footer, switch tabs and close without leaving the screen.
    await clickVisible(".entry-legal .link-button", "Conditions d’utilisation"); await wait("document.querySelector('dialog.legal-dialog[open]')!==null", "terms open");
    assert.equal(await evaluate("document.querySelector('#legal-title').textContent"), "Conditions d’utilisation");
    await audit("French terms of use"); await snapshot("legal-terms-fr");
    await clickVisible(".legal-dialog .tabs button", "Confidentialité"); await wait("document.querySelector('#legal-title').textContent==='Confidentialité'", "privacy tab");
    await clickVisible(".legal-dialog .tabs button", "Logiciels open source"); await wait("document.querySelector('.legal-body tbody')?.textContent.includes('Electron')", "licenses tab");
    await clickVisible(".legal-dialog .legal-header .secondary"); await wait("document.querySelector('dialog.legal-dialog')===null", "legal closed");
    // The welcome screen offers exactly two starts: create a shop, or import a file.
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.entry-choice')).map(element=>element.dataset.authAction)"), ["create", "join", "import"]);
    await click("[data-auth-action=import]"); await wait("document.querySelector('#choose-import-file')!==null");
    await audit("French import entry"); await snapshot("import-fr");
    await click(".entry-back"); await wait("document.querySelector('[data-auth-action=create]')!==null");
    await click("[data-auth-action=create]"); await wait("document.querySelector('#shop-name')!==null");
    await audit("French shop details"); await snapshot("setup-details-fr");
    await evaluate("Array.from(document.querySelectorAll('.language-switch button')).find(element=>element.textContent==='EN').click()");
    await click(".setup-options summary");
    for (const [selector, value] of [["#shop-name", "Desktop validation"], ["#owner-name", "Owner"], ["#device-name", "Till"], ["#cash-name", "Cash"]]) await fill(selector!, value!);
    await submit("#shop-name"); await wait("document.querySelector('#local-secret')!==null");
    assert.ok(await evaluate("document.querySelector('.setup-accept')?.textContent.includes('Terms of use')"), "setup names the terms");
    await audit("English owner access"); await snapshot("setup-access-en");
    await click(".entry-back"); await wait("document.querySelector('#shop-name')!==null");
    assert.equal(await evaluate("document.querySelector('#shop-name').value"), "Desktop validation");
    assert.equal(await evaluate("document.querySelector('#owner-name').value"), "Owner");
    await submit("#shop-name"); await wait("document.querySelector('#local-secret')!==null");
    await fill("#local-secret", "654321"); await fill("#confirm-secret", "112233"); await submit("#local-secret");
    await wait("document.querySelector('[role=alert]')!==null");
    await audit("Setup validation error");
    assert.equal(await evaluate("window.kolo.getWorkspace().then(result=>result.value.state)"), "empty");
    await fill("#confirm-secret", "654321"); await submit("#local-secret");
    await wait("document.querySelector('dialog[open]')!==null"); await audit("Recovery key dialog"); await click("dialog button");
    await wait("document.querySelector('#till-search')!==null");
    await audit("English till");
    await navigate("Products & stock"); await click(".section-heading .primary");
    for (const [selector, value] of [["#product-name", "Rice"], ["#product-unit", "bag"], ["#product-barcode", "123456789"], ["#product-price", "500"], ["#product-cost", "300"], ["#opening-stock", "3"]]) await fill(selector!, value!);
    await click(".form-panel input[type=checkbox]"); await snapshot("product-form");
    await navigate("Till"); await navigate("Products & stock");
    assert.equal(await evaluate("document.querySelector('#product-name').value"), "Rice");
    await submit("#product-name");
    await wait("document.querySelector('#product-name')===null && document.querySelector('tbody')?.textContent.includes('Rice')"); await snapshot("products-list");
    await navigate("Till"); await wait("document.querySelector('.product-tile')?.textContent.includes('Rice')");
    // A keyboard scanner uses the same exact barcode path as physical keyboard hardware.
    window.show(); window.focus(); window.webContents.focus();
    await wait("document.hasFocus()", "window keyboard focus");
    await evaluate("document.querySelector('#barcode-scan').focus()");
    for (let scan = 1; scan <= 2; scan++) {
      await fill("#barcode-scan", "123456789");
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      try {
        await wait(`document.querySelector('.cart-lines input')?.value==='${scan}' && document.activeElement?.id==='barcode-scan' && !document.querySelector('#barcode-scan').disabled`);
      } catch {
        const keyboardState = await evaluate("JSON.stringify({active:document.activeElement?.id,quantity:document.querySelector('.cart-lines input')?.value,disabled:document.querySelector('#barcode-scan')?.disabled})");
        process.stderr.write(`Desktop fixture keyboard state: ${keyboardState}\n`);
        throw new Error("keyboard scanner focus failed");
      }
    }
    await fill(".cart-lines input", "0.5");
    await navigate("Products & stock"); await navigate("Till");
    assert.equal(await evaluate("document.querySelector('.cart-lines input').value"), "0.5");
    await wait("document.querySelector('.total-line')?.textContent.includes('250')"); await snapshot("till-cart");
    if (process.env["KOLO_DESKTOP_SMOKE_SCREENSHOT"] !== undefined) {
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))");
      await writeFile(process.env["KOLO_DESKTOP_SMOKE_SCREENSHOT"], (await window.webContents.capturePage()).toPNG());
    }
    await click(".checkout"); await wait("document.querySelector('.receipt-paper')?.textContent.includes('250')"); await snapshot("receipt-cash");
    assert.match(await evaluate<string>("document.querySelector('.receipt-paper .receipt-brand')?.textContent ?? ''"), /Generated by kolo · made by hblabs/, "receipt branding");
    assert.equal(await evaluate("document.querySelector('.notice.error')===null"), true);
    const checks = await evaluate<{ total: number; stock: number; sameId: boolean; history: number; conflict: string; deniedExtra: string; bridgeSafe: boolean }>(`(async()=>{
      const workspace=(await window.kolo.getWorkspace()).value, sessionId=workspace.sessionId;
      const history=(await window.kolo.listReceipts({sessionId})).value;
      const receipt=(await window.kolo.getReceipt({sessionId,saleId:history.items[0].id})).value;
      const product=(await window.kolo.listProducts({sessionId})).value.items[0];
      const request={sessionId,requestId:receipt.id,accountId:receipt.payments[0].accountId,lines:receipt.lines.map(line=>({productId:line.productId,quantity:line.quantity,unitPriceMinor:line.unitPriceMinor}))};
      const retry=await window.kolo.checkout(request), conflict=await window.kolo.checkout({...request,lines:request.lines.map(line=>({...line,quantity:1000}))});
      const extra=await window.kolo.listProducts({sessionId,businessId:'forged'});
      return {total:receipt.totalMinor,stock:product.onHandThousandths,sameId:retry.ok&&retry.value.saleId===receipt.id,history:(await window.kolo.listReceipts({sessionId})).value.items.length,conflict:conflict.error.code,deniedExtra:extra.error.code,bridgeSafe:!('invoke' in window.kolo)&&!('executeSql' in window.kolo)};
    })()`);
    assert.deepEqual(checks, { total: 250, stock: 2500, sameId: true, history: 1, conflict: "request_conflict", deniedExtra: "invalid_input", bridgeSafe: true });
    // Product detail: manual stock in, shelf count, detail edit and a category, through the DOM.
    await navigate("Products & stock"); await click(".row-link"); await wait("document.querySelector('.facts')?.textContent.includes('2.5')", "product detail");
    await fill("#movement-quantity", "2"); await fill("#movement-reason", "Delivery"); await submit("#movement-quantity");
    await wait("document.querySelector('.notice.success')!==null && document.querySelector('.facts').textContent.includes('4.5')", "stock added");
    await click("input[name=movement-kind][value=count]"); await fill("#movement-quantity", "4"); await fill("#movement-reason", "Shelf"); await submit("#movement-quantity");
    await wait("document.querySelector('.notice.success')?.textContent.includes('-0.5') && document.querySelector('.facts').textContent.includes('4 bag')", "stock counted");
    await wait("document.querySelectorAll('.detail-layout tbody tr').length===4", "stock history"); await snapshot("product-detail");
    await press(".detail-heading button", "Edit"); await snapshot("product-edit"); await fill("#edit-name", "Rice 25kg"); await submit("#edit-name");
    await wait("document.querySelector('.detail-layout h2')?.textContent==='Rice 25kg' && document.querySelector('#edit-name')===null", "product edit");
    // Photo: a large landscape PNG picked through the real file input becomes a small square WebP thumbnail.
    await evaluate(`(async()=>{const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=800;const c=canvas.getContext('2d');c.fillStyle='#c0392b';c.fillRect(0,0,1200,800);c.fillStyle='#f1c40f';c.fillRect(400,200,400,400);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const input=document.querySelector('.photo-editor input[type=file]');const transfer=new DataTransfer();transfer.items.add(new File([blob],'rice.png',{type:'image/png'}));
      input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait("document.querySelector('img.photo-preview')?.src.startsWith('data:image/webp;base64,')===true", "product photo saved");
    assert.equal(await evaluate("(()=>{const img=document.querySelector('img.photo-preview');return img.naturalWidth===320&&img.naturalHeight===320;})()"), true, "photo stored as a 320 px square");
    await snapshot("product-photo");
    await press(".tabs button", "Categories"); await fill("#category-name", "Grain"); await submit("#category-name");
    await wait("Array.from(document.querySelectorAll('tbody')).some(element=>element.textContent.includes('Grain'))", "category created"); await snapshot("categories");
    // Credit: a customer with a limit buys with part payment, then pays some of the balance.
    await navigate("Customers"); await click(".section-heading .primary"); await fill("#customer-name", "Awa"); await fill("#customer-limit", "1000"); await submit("#customer-name");
    await wait("(()=>{const v=s=>Array.from(document.querySelectorAll(s)).filter(e=>e.offsetParent!==null);return v('.detail-layout h2')[0]?.textContent==='Awa';})()", "customer created"); await snapshot("customer-detail");
    await navigate("Till"); await wait("document.querySelector('.product-tile')?.textContent.includes('Rice 25kg')", "edited product in till"); await wait("document.querySelector('.product-tile img.has-photo')!==null", "photo on till tile"); await snapshot("till-photo");
    await click(".product-tile"); await fill("#customer-search", "Aw"); await wait("document.querySelector('.customer-results button')!==null", "customer search");
    await click(".customer-results button"); await wait("document.querySelector('.customer-choice')?.textContent.includes('Awa')", "customer chosen");
    await click("#sale-on-debt"); await fill("#debt-received", "200"); await wait("Array.from(document.querySelectorAll('.settlement-line')).some(element=>element.textContent.includes('300'))", "credit remainder");
    await fill("#cash-received", "500"); await wait("document.querySelector('.change-line')?.textContent.includes('300')", "change due"); await snapshot("till-credit");
    await click(".checkout"); await wait("document.querySelector('.receipt-paper')?.textContent.includes('Awa') && document.querySelector('.receipt-owing')?.textContent.includes('300')", "credit receipt"); await snapshot("receipt-credit");
    await navigate("Customers"); await wait("(()=>{const v=s=>Array.from(document.querySelectorAll(s)).filter(e=>e.offsetParent!==null);return v('.facts')[0]?.textContent.includes('300');})()", "customer balance");
    await fill("#payment-amount", "100"); await submit("#payment-amount");
    await wait("(()=>{const v=s=>Array.from(document.querySelectorAll(s)).filter(e=>e.offsetParent!==null);return v('.notice.success').length===1 && v('.facts')[0]?.textContent.includes('200') && v('.detail-layout tbody tr').length===2;})()", "customer payment");
    // Purchase: a supplier delivery received at cost, part paid at the door and the rest owed.
    await navigate("Purchases & suppliers"); await clickVisible(".tabs button", "Suppliers"); await clickVisible(".actions.spaced button");
    await fill("#supplier-name", "Grossiste"); await submit("#supplier-name"); await wait(`${visible(".detail-layout h2")}[0]?.textContent==='Grossiste'`, "supplier created"); await snapshot("supplier-detail");
    await clickVisible(".tabs button", "Purchases"); await clickVisible(".section-heading .primary");
    await fill("#supplier-search", "Gro"); await wait(`${visible(".customer-results button")}.length===1`, "supplier search"); await clickVisible(".customer-results button");
    await fill("#purchase-product", "Rice"); await wait(`${visible(".customer-results button")}.length===1`, "product search"); await clickVisible(".customer-results button");
    await fill(".purchase-form .cell-input", "5"); await fill(".purchase-form td:nth-child(3) .cell-input", "300"); await fill("#purchase-paid", "500");
    await wait(`${visible(".purchase-form .settlement-line")}[0]?.textContent.includes('1,000')`, "supplier payable"); await snapshot("purchase-form");
    await submit("#purchase-reference"); await wait("document.querySelector('.purchase-form')===null && document.querySelector('.record-layout tbody tr')!==null", "purchase recorded"); await snapshot("purchases-list");
    await clickVisible(".tabs button", "Suppliers"); await wait(`${visible(".facts dd")}[0]?.textContent.replace(/[^0-9-]/g,'')==='1000'`, "supplier balance");
    // Money: cash in, a count that is short and its correction, then an expense from the till.
    await navigate("Accounts & expenses"); await clickVisible(".row-link", "Cash"); await wait(`${visible(".facts dd")}[0]?.textContent.replace(/[^0-9-]/g,'')==='50'`, "cash balance");
    await fill("#money-amount", "1000"); await fill("#money-reason", "Float"); await submit("#money-amount"); await wait(`${visible(".facts dd")}[0]?.textContent.replace(/[^0-9-]/g,'')==='1050'`, "money in");
    await fill("#cash-counted", "1000"); await submit("#cash-counted"); await wait(`${visible(".facts.compare")}[0]?.textContent.includes('-50')`, "cash compared"); await snapshot("account-count");
    await fill("#cash-correction-reason", "Shortage"); await submit("#cash-correction-reason"); await wait(`${visible(".facts")}[0]?.textContent.includes('1,000')`, "cash corrected");
    await clickVisible(".tabs button", "Expenses"); await fill("#expense-amount", "200"); await fill("#expense-description", "Charcoal"); await submit("#expense-amount");
    await wait(`${visible("tbody tr")}.some(row=>row.textContent.includes('200'))`, "expense recorded"); await snapshot("expenses");
    await clickVisible(".tabs button", "Accounts"); await wait(`${visible(".facts dd")}[0]?.textContent.replace(/[^0-9-]/g,'')==='800'`, "balance after expense");
    // Reports: today's summary reflects the two sales (250 + 500) and the expense.
    await navigate("Reports"); await wait("document.querySelector('.stat-tile strong')?.textContent.replace(/[^0-9-]/g,'')==='750'", "sales report");
    await audit("Reports");
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.stat-tile')).find(tile=>tile.textContent.startsWith('Expenses'))?.textContent.replace(/[^0-9-]/g,'')"), "200");
    // Save as PDF: the main process reads the report again and renders an A4 page in its script-less print window.
    await clickVisible(".report-export button", "Save as PDF"); await wait(`${visible(".report-export .notice.success")}.length===1`, "report saved as PDF");
    const pdfDirectory = join(process.env["KOLO_DESKTOP_SMOKE_DIR"]!, "saved"), reportPdf = (await readdir(pdfDirectory)).filter(name => name.endsWith(".pdf")).sort().at(-1);
    assert.ok(reportPdf !== undefined && /kolo-dashboard_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.pdf$/.test(reportPdf), "the PDF is named after its report and period");
    const pdfBytes = await readFile(join(pdfDirectory, reportPdf));
    assert.ok(pdfBytes.length > 1000 && pdfBytes.subarray(0, 5).toString() === "%PDF-", "report PDF rendering");
    if (process.env["KOLO_DESKTOP_SMOKE_REPORT_PDF"] !== undefined) await writeFile(process.env["KOLO_DESKTOP_SMOKE_REPORT_PDF"], pdfBytes);
    // Analytics: the default period includes today; KPIs, trend, heatmap, best sellers and shares render.
    await navigate("Analytics"); await wait("document.querySelector('.stat-tile strong')?.textContent.replace(/[^0-9-]/g,'')==='750'", "analytics summary");
    await wait(`${visible(".chart-frame .recharts-wrapper")}.length===2 && ${visible(".heatmap-cell:not(.is-empty)")}.length>0 && ${visible(".donut .recharts-wrapper")}.length===2`, "analytics charts");
    await audit("Analytics");
    for (const [index, card] of ["busy", "sellers", "shares"].entries()) { await evaluate(`document.querySelectorAll('.analytics .chart-card')[${index + 1}]?.scrollIntoView()`); await snapshot(`analytics-${card}`); }
    // Journal: the day's operations appear with who made them; choosing a record narrows to its history.
    await navigate("Journal"); await wait(`${visible(".journal-table tbody tr")}.some(row=>row.textContent.includes('Expense')&&row.textContent.includes('Charcoal'))`, "journal entries");
    await audit("Journal"); await snapshot("journal");
    // Export: every matching operation goes to one .csv through the save dialog, readable as a spreadsheet.
    await clickVisible(".journal-export button", "Export CSV"); await wait(`${visible(".notice.success")}.some(element=>element.textContent.includes('exported'))`, "journal exported");
    const exportsDirectory = join(process.env["KOLO_DESKTOP_SMOKE_DIR"]!, "saved"), exported = (await readdir(exportsDirectory)).filter(name => name.endsWith(".csv")).sort().at(-1);
    assert.ok(exported !== undefined && /kolo-journal-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/.test(exported), "the export is named after its period");
    const csv = await readFile(join(exportsDirectory, exported), "utf8");
    assert.ok(csv.startsWith("\uFEFFDate,Time,UTC timestamp,Member,Device,Operation,Code,Record,Related,Amount (XAF),Details,Source,Status,ID\r\n"), "English exports use commas and a byte-order mark");
    assert.ok(csv.split("\r\n").some(line => line.includes(",Expense,EXPENSE_RECORDED,") && line.includes("Charcoal")), "the day's expense is in the file");
    await evaluate(`${visible(".journal-table .row-link")}[0].click()`); await wait(`${visible(".journal-subject")}.length===1 && ${visible(".journal-table tbody tr")}.length>0`, "journal record history");
    // Settings: an explicit appearance overrides the system theme and persists; "System" follows it again.
    await navigate("Settings"); await wait(`${visible("input[name=appearance]")}.length===3`, "settings page");
    await audit("Settings");
    assert.match(await evaluate<string>("document.querySelector('.about-panel dd')?.textContent ?? ''"), /^KOLO \d+\.\d+\.\d+$/, "settings shows the version");
    const canvas = "getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()";
    const previousTheme = nativeTheme.themeSource;
    try {
      for (const [system, choice, expected] of [["light", "Dark", "#1f2b25"], ["dark", "Light", "#f4f7f3"]] as const) {
        nativeTheme.themeSource = system;
        await clickVisible("input[name=appearance]", undefined, choice);
        await wait(`${canvas}===${JSON.stringify(expected)}`, `explicit ${choice} appearance`);
        assert.equal(await evaluate("localStorage.getItem('kolo.appearance')"), choice.toLowerCase());
        await evaluate("new Promise(resolve=>{const timer=setTimeout(resolve,100);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));})");
        await snapshot(`settings-${choice.toLowerCase()}-over-${system}`);
      }
      await clickVisible("input[name=appearance]", undefined, "System");
      await wait(`document.documentElement.dataset.theme===undefined && ${canvas}==='#1f2b25'`, "system appearance restored");
    } finally { nativeTheme.themeSource = previousTheme; }
    // Tax and payment terms (ADR-033): switch tax on at the standard rate, shorten customer terms; both save.
    await click("#tax-enabled"); await submit("#tax-label");
    await wait(`${visible(".notice.success")}.some(element=>element.textContent==='Tax settings saved.')`, "tax saved");
    await fill("#terms-customers", "15"); await submit("#terms-customers");
    await wait(`${visible(".notice.success")}.some(element=>element.textContent==='Terms saved.')`, "terms saved");
    await audit("Settings with tax and terms"); await snapshot("settings-tax-terms");
    // Alerts open from the topbar; the cash shortage was corrected, so nothing is outstanding.
    await click(".alerts-button"); await wait(`${visible("#alerts-panel")}.length===1 && ${visible("#alerts-panel p")}.some(element=>element.textContent==='No alerts.')`, "alerts panel");
    await audit("Alerts"); await snapshot("alerts"); await clickVisible("#alerts-panel button", "Close");
    // The tax report: every sale so far was before tax was on, so it is all at rate 0.
    await navigate("Reports");
    await evaluate("(()=>{const select=document.querySelector('#report-kind');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'tax');select.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await wait(`${visible(".stat-tile")}.some(tile=>tile.textContent.startsWith('Tax · TVA'))`, "tax report");
    await audit("Tax report"); await snapshot("report-tax");
    // A product's tax rule and a customer's due dates.
    // Both detail screens are still open from earlier in this phase.
    await navigate("Products"); await clickVisible(".tabs button", "Products"); await wait(`${visible("#product-tax-rule")}.length===1 && ${visible(".detail-layout h2")}[0]?.textContent==='Rice 25kg'`, "product tax panel");
    await audit("Product with tax rule"); await snapshot("product-tax");
    await navigate("Customers"); await wait(`${visible(".panel h2")}.some(element=>element.textContent==='Due dates')`, "customer due dates");
    await audit("Customer with due dates"); await snapshot("customer-due-dates");
    // Return: one bag of the credit sale comes back; its value is credited to the customer.
    await navigate("Receipts"); await clickVisible(".receipt-list .row-link"); await wait(`${visible(".receipt-paper")}[0]?.textContent.includes('Awa')`, "credit receipt");
    // Half-width window: the open record replaces the list at the top, and Back returns to the list.
    window.setSize(880,620);
    await clickVisible(".receipt-paper .back-to-list"); await wait(`${visible(".receipt-paper")}.length===0 && ${visible(".receipt-list .row-link")}.length>0`, "narrow back to list");
    await evaluate("scrollTo(0,document.body.scrollHeight)"); await clickVisible(".receipt-list .row-link");
    await wait(`${visible(".receipt-list")}.length===0 && (r=>r.top>=0&&r.top<innerHeight)(${visible(".receipt-paper")}[0].getBoundingClientRect()) && ${visible(".receipt-paper")}[0].textContent.includes('Awa')`, "narrow receipt replaces list in view");
    await snapshot("receipt-narrow"); window.setSize(1280,850);
    await clickVisible(".receipt-paper button", "Return items"); await wait(`document.querySelector("dialog.return-form")?.open===true && ${visible(".return-form .cell-input")}.length===1 && document.activeElement===document.querySelector(".return-form h2")`, "return dialog open and focused");
    await fill(".return-form .cell-input", "1"); await wait(`${visible(".return-form .total-line")}[0]?.textContent.replace(/[^0-9]/g,'')==='500'`, "return preview"); await snapshot("return-form");
    await fill("#return-reason", "Damaged"); await submit("#return-reason");
    await wait(`document.querySelector('.return-form')===null && ${visible(".receipt-paper")}[0]?.textContent.includes('Returned')`, "return recorded");
    // Printing uses the OS print path; rendering to PDF exercises the same print stylesheet without a dialog.
    const printed = await window.webContents.printToPDF({ pageSize: { width: 2.83, height: 11 }, printBackground: false });
    assert.ok(printed.length > 1000 && printed.subarray(0, 4).toString() === "%PDF", "receipt print rendering");
    if (process.env["KOLO_DESKTOP_SMOKE_RECEIPT_PDF"] !== undefined) await writeFile(process.env["KOLO_DESKTOP_SMOKE_RECEIPT_PDF"], printed);
    // Staff: the owner adds a cashier through the native vault and grants credit sales.
    await navigate("Staff"); await clickVisible(".section-heading .primary");
    for (const [selector, value] of [["#member-name", "Zoé"], ["#member-secret", "765432"], ["#member-confirm", "765432"]]) await fill(selector!, value!);
    await submit("#member-name"); await wait(`${visible(".staff-detail h2")}[0]?.textContent==='Zoé'`, "staff created");
    await clickVisible(".permission-group .check input:not(:checked)", undefined, "Sell on credit");
    await wait(`${visible(".permission-group .check")}.find(label=>label.textContent==='Sell on creditException')?.querySelector('input').checked===true`, "credit granted as an exception"); await snapshot("staff-detail");
    // Role matrix: ticking a cell gives the whole role the permission and marks the role customized.
    await clickVisible(".tabs button", "Roles"); await clickVisible(".role-matrix input[aria-label='Cashier · View sales reports']");
    await wait(`${visible(".role-matrix input[aria-label='Cashier · View sales reports']")}[0]?.checked===true && ${visible(".role-matrix thead .tag")}.length===1`, "cashier role customized");
    await snapshot("role-matrix"); await clickVisible(".tabs button", "Members");
    if (process.env["KOLO_DESKTOP_SMOKE_REPORT_SCREENSHOT"] !== undefined) await writeFile(process.env["KOLO_DESKTOP_SMOKE_REPORT_SCREENSHOT"], (await window.webContents.capturePage()).toPNG());
    assert.equal(await evaluate("document.querySelector('.notice.error')===null"), true);
    // Backup, then restore it over this shop: the activated database is served by a new
    // application, the restored shop opens locked, and the restart phase must find it.
    await navigate("Backup & devices");
    await audit("Backup and devices");
    // The standalone desktop now offers a real local QR even with no connected server.
    process.stdout.write("Desktop workflow: showing local QR\n");
    await click("#show-local-join"); await wait("document.querySelector('.join-qr')?.complete && document.querySelector('.join-qr')?.naturalWidth>0 && document.querySelector('.join-big-code')!==null", "standalone local QR displayed");
    assert.ok(await evaluate("document.querySelector('.join-code .share-code')?.textContent.startsWith('kolo://local?')"));
    assert.equal(await evaluate("window.kolo.getWorkspace().then(result=>window.kolo.serverState({sessionId:result.value.sessionId})).then(result=>result.value.servers.length)"),0);
    await audit("Local QR pairing without a server"); await snapshot("pairing-local-qr");
    process.stdout.write("Desktop workflow: local QR and accessibility passed\n");
    await click(".join-code .text-button"); await wait("document.querySelector('.join-qr')===null", "local invite cancelled");
    for (const [selector, value] of [["#backup-password", "correct horse battery"], ["#backup-confirm", "correct horse battery"]]) await fill(selector!, value!);
    await submit("#backup-password"); await wait(`${visible(".notice.success")}.some(element=>element.textContent==='File saved.')`, "backup saved");
    await fill("#restore-password", "correct horse battery"); await submit("#restore-password"); await wait(`${visible(".file-summary")}[0]?.textContent.includes('Desktop validation')`, "backup checked"); await snapshot("restore-form");
    for (const [selector, value] of [["#restore-name", "Desktop validation"], ["#restore-secret", "654321"], ["#restore-confirm", "654321"]]) await fill(selector!, value!);
    await submit("#restore-name"); await wait("document.querySelector('#local-secret')!==null", "restored shop locked");
    process.stdout.write("Actual Electron DOM setup, protected credentials, product/opening stock, barcode, fractional cash checkout, saved receipt, stock movement/count, product edit, category, credit sale, customer payment, supplier purchase, cash count/correction, expense, reports, sale return, staff and backup/restore passed\n");
  } else if (phase === "reopen") {
    await wait("document.querySelector('#local-secret')!==null");
    const state = await evaluate<string>("window.kolo.getWorkspace().then(result=>result.value.state)"); assert.equal(state, "locked");
    await fill("#local-secret", "654321"); await submit("#local-secret");
    await wait("document.querySelector('#till-search')!==null");
    await navigate("Receipts"); await wait("document.querySelector('.receipt-list .row-link')!==null"); await click(".receipt-list .row-link");
    await wait("document.querySelector('.receipt-paper')?.textContent.includes('Awa')");
    const stateAfter = await evaluate<{ stock: number; total: number }>(`(async()=>{const {sessionId}=(await window.kolo.getWorkspace()).value;const history=(await window.kolo.listReceipts({sessionId})).value;return {stock:(await window.kolo.listProducts({sessionId})).value.items[0].onHandThousandths,total:(await window.kolo.getReceipt({sessionId,saleId:history.items[0].id})).value.totalMinor};})()`);
    assert.deepEqual(stateAfter, { stock: 9000, total: 500 });
    // Staying signed in is on by default; the following phases verify locked boots, so turn it off in Settings.
    await navigate("Settings"); await wait(`${visible("#remember-session")}[0]?.checked===true`, "stay signed in defaults on");
    await clickVisible("#remember-session"); await wait(`${visible("#remember-session")}[0]?.checked===false && !${visible("#remember-session")}[0].disabled`, "stay signed in turned off");
    process.stdout.write("Actual Electron process restart, locked boot, credential unlock and persisted receipt/stock passed\n");
  } else if (["resilience", "crash-commit", "crash-reopen"].includes(phase)) {
    await wait("document.querySelector('#local-secret')!==null");
    assert.equal(await evaluate("window.kolo.getWorkspace().then(result=>result.value.state)"), "locked");
    await fill("#local-secret", "654321"); await submit("#local-secret");
    await wait("document.querySelector('#till-search')!==null");
    if (phase === "crash-commit") {
      const committed = await evaluate(`(async()=>{
        const {sessionId}=(await window.kolo.getWorkspace()).value;
        const product=(await window.kolo.listProducts({sessionId})).value.items[0];
        const account=(await window.kolo.listAccounts({sessionId})).value.items[0];
        return await window.kolo.checkout({sessionId,requestId:crypto.randomUUID(),accountId:account.id,lines:[{productId:product.id,quantity:1000,unitPriceMinor:500}]});
      })()`);
      assert.equal((committed as { ok: boolean }).ok, true);
      process.stdout.write("KOLO_CRASH_READY\n");
      await new Promise(() => {}); // The parent kills the real main process after the durable reply.
    } else if (phase === "crash-reopen") {
      const recovered = await evaluate(`(async()=>{const {sessionId}=(await window.kolo.getWorkspace()).value;return {count:(await window.kolo.listReceipts({sessionId})).value.items.length,stock:(await window.kolo.listProducts({sessionId})).value.items[0].onHandThousandths};})()`);
      assert.deepEqual(recovered, { count: 3, stock: 8000 });
      process.stdout.write("Forced main-process termination retained committed sale exactly once and rebooted locked\n");
    } else {
      const recovery = await evaluate(`(async()=>{
        const expect=result=>{if(!result.ok)throw Error(result.error.code);return result.value;};
        const initial=expect(await window.kolo.getWorkspace()),ownerId=initial.members.find(member=>member.name===initial.actor.name).id;
        const before=expect(await window.kolo.listReceipts({sessionId:initial.sessionId})).items.length;
        const key=expect(await window.kolo.recoveryKey({sessionId:initial.sessionId,secret:'654321'}));
        const recovered=expect(await window.kolo.recoverAccess({recoveryCode:key,newSecret:'112233'}));
        if(recovered.state!=='locked')throw Error('recovery must lock');
        const next=expect(await window.kolo.unlock({userId:ownerId,secret:'112233'}));
        const after=expect(await window.kolo.listReceipts({sessionId:next.sessionId})).items.length;
        const nextKey=expect(await window.kolo.recoveryKey({sessionId:next.sessionId,secret:'112233'}));
        expect(await window.kolo.recoverAccess({recoveryCode:nextKey,newSecret:'654321'}));
        expect(await window.kolo.unlock({userId:ownerId,secret:'654321'}));
        return {before,after};
      })()`);
      assert.deepEqual(recovery, { before: 2, after: 2 });
      await wait("document.querySelector('#till-search')!==null", "owner recovered");
      // Native keyboard events prove the skip link is reachable and hidden screens stay out of focus.
      await evaluate("document.activeElement?.blur(); document.querySelector('.skip-link').focus()");
      assert.equal(await evaluate("document.activeElement.textContent"), "Skip to content");
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      await wait("document.activeElement?.id==='main-content'", "skip link focus");
      window.minimize(); await wait("window.kolo.getWorkspace().then(result=>result.value.state==='locked')", "minimize lock");
      window.restore(); window.show(); window.focus();
      await wait("document.querySelector('#local-secret')!==null"); await fill("#local-secret", "654321"); await submit("#local-secret");
      await wait("document.querySelector('#till-search')!==null");
      const crashed = new Promise<void>(resolve => window.webContents.once("render-process-gone", () => resolve()));
      const reloadUrl = window.webContents.getURL();
      process.kill(window.webContents.getOSProcessId(), "SIGKILL"); await crashed;
      await window.loadURL(reloadUrl);
      await wait("document.querySelector('#local-secret')!==null", "renderer crash locked recovery");
      assert.equal(await evaluate("window.kolo.getWorkspace().then(result=>result.value.state)"), "locked");
      process.stdout.write("Native owner code replacement preserved receipts; keyboard skip link, minimize lock and renderer crash recovery passed\n");
    }
  } else if (phase === "entry-recovery") {
    await wait("document.querySelector('#local-secret')!==null");
    await audit("Desktop login"); await snapshot("login-en");
    // The code can be revealed to check typing, and hidden again before unlocking.
    await fill("#local-secret", "654321"); await click(".secret-toggle[aria-controls=local-secret]");
    await wait("document.querySelector('#local-secret').type==='text' && document.querySelector('.secret-toggle').textContent==='Hide'", "reveal code");
    await audit("Desktop login with code shown"); await snapshot("login-code-shown-en");
    await click(".secret-toggle[aria-controls=local-secret]"); await wait("document.querySelector('#local-secret').type==='password'", "hide code");
    await fill("#local-secret", "");
    window.setSize(880,620);
    await audit("Login at minimum desktop width");
    assert.equal(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"),true);
    await snapshot("login-compact-en"); window.setSize(1280,850);
    await fill("#local-secret", "654321"); await submit("#local-secret");
    await wait("document.querySelector('#till-search')!==null");
    const key = await evaluate<string>("window.kolo.getWorkspace().then(result=>window.kolo.recoveryKey({sessionId:result.value.sessionId,secret:'654321'})).then(result=>result.value)");
    await evaluate("window.kolo.lock()"); await wait("document.querySelector('[data-auth-action=recover]')!==null");
    await click("[data-auth-action=recover]"); await wait("document.querySelector('#recovery-key')!==null");
    await audit("Owner code recovery"); await snapshot("recovery-en");
    await fill("#recovery-key", key); await fill("#local-secret", "112233"); await fill("#confirm-secret", "112233"); await submit("#recovery-key");
    await wait("document.querySelector('#user-id')!==null && document.querySelector('.notice.success')!==null");
    assert.equal(await evaluate("document.querySelector('#local-secret').value"), "");
    await fill("#local-secret", "112233"); await submit("#local-secret"); await wait("document.querySelector('#till-search')!==null");
    await evaluate(`(async()=>{const {sessionId}=(await window.kolo.getWorkspace()).value;const key=(await window.kolo.recoveryKey({sessionId,secret:'112233'})).value;const result=await window.kolo.recoverAccess({recoveryCode:key,newSecret:'654321'});if(!result.ok)throw Error(result.error.code);})()`);
    process.stdout.write("Desktop choice screens, two-step setup, draft-preserving back navigation, compact login and recovery DOM flow passed\n");
  } else if (phase === "import-replace") {
    // Signed out, importing a backup replaces this computer's shop; the old one becomes a safety copy.
    await wait("document.querySelector('#local-secret')!==null");
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.entry-choice')).map(element=>element.dataset.authAction)"), ["import", "fresh"], "login offers import and starting over besides signing in");
    await audit("Login with import option"); await snapshot("login-import-en");
    await click("[data-auth-action=import]"); await wait("document.querySelector('#choose-import-file')!==null");
    await click("#choose-import-file"); await wait("document.querySelector('#restore-password')!==null", "backup recognized");
    await fill("#restore-password", "correct horse battery"); await submit("#restore-password");
    await wait(`${visible(".file-summary")}[0]?.textContent.includes('Desktop validation')`, "backup checked");
    assert.ok(await evaluate("document.querySelector('.notice[role=note]')?.textContent.includes('Desktop validation')"), "replacement warning names the current shop");
    await audit("Import replacing the current shop"); await snapshot("import-replace-en");
    for (const [selector, value] of [["#restore-name", "Desktop validation"], ["#restore-secret", "654321"], ["#restore-confirm", "654321"]]) await fill(selector!, value!);
    await submit("#restore-name"); await wait("document.querySelector('#local-secret')!==null", "restored shop locked");
    assert.equal(await evaluate("window.kolo.getWorkspace().then(result=>result.value.shopName)"), "Desktop validation");
    assert.ok((await evaluate<{ name: string }[]>("window.kolo.savedShops().then(result=>result.value)")).some(item => item.name === "Desktop validation"), "previous shop kept as a safety copy");
    await fill("#local-secret", "654321"); await submit("#local-secret"); await wait("document.querySelector('#till-search')!==null");
    assert.ok(await evaluate("window.kolo.getWorkspace().then(result=>window.kolo.listProducts({sessionId:result.value.sessionId})).then(result=>result.value.items.length>0)"));
    process.stdout.write("Signed-out import replaced the shop from a backup and kept the previous one as a safety copy\n");
  } else if (phase === "import-reopen") {
    await wait("document.querySelector('#local-secret')!==null");
    assert.equal(await evaluate("window.kolo.getWorkspace().then(result=>result.value.shopName)"), "Desktop validation");
    await fill("#local-secret", "654321"); await submit("#local-secret");
    await wait("document.querySelector('#till-search')!==null");
    process.stdout.write("Imported shop remains active across process restart\n");
  } else if (phase === "start-over") {
    // Without its code or recovery key, a locked till sets its shop aside, reaches the empty home and can reopen it.
    await wait("document.querySelector('#local-secret')!==null");
    const before = (await evaluate<{ id: string }[]>("window.kolo.savedShops().then(result=>result.value)")).map(shop => shop.id);
    await click("[data-auth-action=recover]"); await wait("document.querySelector('#recovery-key')!==null");
    await click(".entry-aside [data-auth-action=fresh]"); await wait("document.querySelector('#fresh-shop-confirmation')!==null", "start-over confirmation");
    assert.equal(await evaluate("document.querySelector('#fresh-shop-confirmation').closest('form').querySelector('[type=submit]').disabled"), true, "the typed name is required");
    await audit("Start over confirmation"); await snapshot("start-over-en");
    await fill("#fresh-shop-confirmation", "Desktop validation"); await submit("#fresh-shop-confirmation");
    await wait("document.querySelector('[data-auth-action=create]')!==null", "empty home after starting over");
    assert.equal(await evaluate("window.kolo.getWorkspace().then(result=>result.value.state)"), "empty");
    const after = (await evaluate<{ id: string; name: string }[]>("window.kolo.savedShops().then(result=>result.value)"));
    const aside = after.findIndex(shop => !before.includes(shop.id));
    assert.ok(aside >= 0 && after[aside]!.name === "Desktop validation", "the shop is set aside, not erased");
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.entry-choice')).map(element=>element.dataset.authAction)"),
      ["create", "join", "import", ...after.map(() => "reopen")], "the empty home offers create, join, import and the set-aside shops");
    await audit("Empty home with set-aside shops"); await snapshot("start-over-home-en");
    await evaluate(`document.querySelectorAll('[data-auth-action=reopen]')[${aside}].click()`);
    await wait("document.querySelector('#local-secret')!==null", "set-aside shop reopens locked");
    assert.equal(await evaluate("window.kolo.getWorkspace().then(result=>result.value.shopName)"), "Desktop validation");
    await fill("#local-secret", "654321"); await submit("#local-secret"); await wait("document.querySelector('#till-search')!==null", "set-aside shop opens with its own code");
    process.stdout.write("Locked till started over without its code, reached the empty home and reopened the set-aside shop\n");
  } else if (phase === "remember-on") {
    await wait("document.querySelector('#local-secret')!==null");
    await fill("#local-secret", "654321"); await submit("#local-secret");
    await wait("document.querySelector('#till-search')!==null");
    await navigate("Settings"); await wait(`${visible("#remember-session")}[0]?.checked===false && !${visible("#remember-session")}[0].disabled`, "stay signed in off");
    await clickVisible("#remember-session"); await wait(`${visible("#remember-session")}[0]?.checked===true && !${visible("#remember-session")}[0].disabled`, "stay signed in turned on");
    await audit("Settings with stay signed in"); await snapshot("settings-remember-en");
    window.minimize(); await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await evaluate("window.kolo.getWorkspace().then(result=>result.value.state)"), "unlocked", "minimize keeps a remembered user");
    window.restore(); window.show(); window.focus();
    process.stdout.write("Stay signed in turned on from Settings; minimizing kept the till open\n");
  } else if (phase === "remember-reopen") {
    await wait("document.querySelector('#till-search')!==null", "remembered user reopens the till");
    assert.equal(await evaluate("window.kolo.getWorkspace().then(result=>result.value.state)"), "unlocked");
    assert.equal(await evaluate("document.querySelector('#local-secret')"), null);
    await clickVisible(".topbar-actions .secondary", "Lock"); await wait("document.querySelector('#local-secret')!==null", "explicit lock");
    process.stdout.write("Remembered user reopened after restart without a code; Lock signed out\n");
  } else if (phase === "remember-locked") {
    await wait("document.querySelector('#local-secret')!==null", "locked after explicit lock");
    assert.equal(await evaluate("window.kolo.getWorkspace().then(result=>result.value.state)"), "locked");
    process.stdout.write("Explicit Lock is remembered across restart\n");
  } else if (phase === "customer-credit") {
    await wait("document.querySelector('#local-secret')!==null");
    await fill("#local-secret", "654321"); await submit("#local-secret"); await wait("document.querySelector('#till-search')!==null");
    await evaluate(`(async()=>{const expect=result=>{if(!result.ok)throw Error(result.error.code);return result.value;};
      const {sessionId}=expect(await window.kolo.getWorkspace());
      const customer=expect(await window.kolo.createCustomer({sessionId,requestId:crypto.randomUUID(),name:'Prepaid customer'}));
      const account=expect(await window.kolo.listCashAccounts({sessionId})).items[0];
      expect(await window.kolo.receiveCustomerPayment({sessionId,requestId:crypto.randomUUID(),customerId:customer.id,accountId:account.id,amountMinor:600}));})()`);
    const choose = async ():Promise<void>=>{
      await navigate("Till"); await wait("document.querySelector('.product-tile')!==null"); await click(".product-tile");
      await fill("#customer-search", "Prepaid"); await wait("document.querySelector('.customer-results button')!==null"); await click(".customer-results button");
      await wait("document.querySelector('.customer-choice')?.textContent.includes('Prepaid customer') && !document.querySelector('.checkout').disabled");
    };
    await choose();
    await wait("document.querySelector('.payment-row input')?.value==='0' && document.querySelector('.cart-settlement')?.textContent.includes('Customer credit used')", "prepaid credit automatically covers the first purchase");
    await audit("Till with customer credit"); await snapshot("till-customer-credit"); await click(".checkout");
    await wait("document.querySelector('.receipt-paper')?.textContent.includes('Balance after sale') && !document.querySelector('.receipt-owing')", "credit receipt has no new debt");
    const firstSale = await evaluate<string>("window.kolo.getWorkspace().then(async result=>(await window.kolo.listReceipts({sessionId:result.value.sessionId})).value.items[0].id)");
    await choose();
    await wait("document.querySelector('.payment-row input')?.value==='400'", "only the remainder after prepaid credit is collected");
    await click("#sale-on-debt"); await wait("document.querySelector('#debt-received')?.value==='0' && !document.querySelector('.checkout').disabled", "explicit debt starts with no money received");
    await wait("document.querySelector('.cart-settlement')?.textContent.includes('New debt')", "purchase crossing zero shows new debt");
    await click(".checkout"); await wait("document.querySelector('.receipt-owing')?.textContent.includes('400')", "only the amount beyond prepaid credit is new debt");
    await audit("Receipt with applied customer credit"); await snapshot("receipt-customer-credit");
    const historical = await evaluate(`(async()=>{const {sessionId}=(await window.kolo.getWorkspace()).value;return (await window.kolo.getReceipt({sessionId,saleId:${JSON.stringify(firstSale)}})).value.customerAccount;})()`);
    assert.deepEqual(historical,{balanceBeforeMinor:-600,balanceAfterMinor:-100,creditAppliedMinor:500,debtAddedMinor:0});
    await navigate("Customers"); await wait(`${visible('.row-link')}.some(element=>element.textContent.includes('Prepaid customer'))`); await clickVisible(".row-link","Prepaid customer");
    await wait(`${visible('.detail-layout tbody')}.some(element=>element.textContent.includes('Customer credit used') && element.textContent.includes('Received at sale'))`, "statement explains the purchases and prepaid credit");
    await audit("Customer statement with prepaid credit"); await snapshot("statement-customer-credit");
    process.stdout.write("Actual Electron customer credit covers a purchase, offsets the next debt and agrees with historical receipts and statements\n");
    // A customer who hands over more than the total can leave the change on account.
    await evaluate(`(async()=>{const {sessionId}=(await window.kolo.getWorkspace()).value;const result=await window.kolo.createCustomer({sessionId,requestId:crypto.randomUUID(),name:'Change customer'});if(!result.ok)throw Error(result.error.code);})()`);
    await navigate("Till"); await wait("document.querySelector('.product-tile')!==null"); await click(".product-tile");
    await fill("#customer-search", "Change customer"); await wait("document.querySelector('.customer-results button')!==null"); await click(".customer-results button");
    await wait("document.querySelector('.customer-choice')?.textContent.includes('Change customer') && !document.querySelector('.checkout').disabled");
    const due = Number(await evaluate<string>("document.querySelector('.payment-row input').value"));
    assert.ok(due > 0, "the sale is paid in cash");
    await fill("#cash-received", String(due + 300)); await wait("document.querySelector('#keep-change')!==null && document.querySelector('.change-line')?.textContent.includes('300')", "keeping the change is offered beside the change due");
    await click("#keep-change"); await wait("document.querySelector('.kept-change-line')?.textContent.includes('300') && !document.querySelector('.change-line')", "the change is shown as kept, not handed back");
    await audit("Till keeping change as credit"); await snapshot("till-kept-change"); await click(".checkout");
    await wait("document.querySelector('.receipt-kept-change')?.textContent.includes('300')", "the receipt shows the change kept as credit");
    await audit("Receipt with change kept as credit"); await snapshot("receipt-kept-change");
    const kept = await evaluate<number>(`(async()=>{const {sessionId}=(await window.kolo.getWorkspace()).value;const found=(await window.kolo.listCustomers({sessionId,term:'Change customer'})).value.items[0];return (await window.kolo.getCustomer({sessionId,customerId:found.id})).value.outstandingMinor;})()`);
    assert.equal(kept, -300, "the customer holds the change as an advance");
    process.stdout.write("Actual Electron till keeps a customer's change on account and prints it on the receipt\n");
  } else if (phase === "restore-file") {
    // Fresh installation restores a supplied backup from the entry screen, as a new shop PC would.
    const password = process.env["KOLO_DESKTOP_SMOKE_OPEN_PASSWORD"], shop = process.env["KOLO_DESKTOP_SMOKE_OPEN_SHOP"];
    if (password === undefined || shop === undefined) throw new Error("restore-file needs the backup password and shop name");
    await wait("document.querySelector('[data-auth-action=import]')!==null");
    // From a locked shop's login page, the import replaces that shop and keeps it as a safety copy.
    const current = await evaluate<string | null>("window.kolo.getWorkspace().then(result=>result.value.state==='empty'?null:result.value.shopName)");
    await click("[data-auth-action=import]"); await wait("document.querySelector('#choose-import-file')!==null");
    await click("#choose-import-file"); await wait("document.querySelector('#restore-password')!==null", "backup recognized");
    await fill("#restore-password", password); await submit("#restore-password");
    await wait(`${visible(".file-summary")}[0]?.textContent.includes(${JSON.stringify(shop)})`, "backup checked");
    for (const [selector, value] of [["#restore-name", shop], ["#restore-secret", "135790"], ["#restore-confirm", "135790"]]) await fill(selector!, value!);
    await snapshot("restore-file-form");
    await submit("#restore-name"); await wait("document.querySelector('#local-secret')!==null", "restored shop locked");
    if (current !== null) assert.ok((await evaluate<{ name: string }[]>("window.kolo.savedShops().then(result=>result.value)")).some(item => item.name === current), "previous shop kept");
    // Open the restored shop and capture the busiest lists for layout review.
    await fill("#local-secret", "135790"); await submit("#local-secret"); await wait("document.querySelector('.nav-item')!==null", "restored shop opens");
    await clickVisible(".language-switch button", "EN");
    await wait(`${visible(".nav-item")}.some(element=>element.textContent.includes("Till"))`, "English labels");
    for (const [label, name] of [["Purchases", "purchases"], ["Receipts", "receipts"], ["Products & stock", "products"]] as const) {
      await navigate(label); await wait(`${visible("tbody tr")}.length>3`, `${name} rows`);
      if (name !== "products") {
        // Visited sections stay mounted but hidden; measure the visible one.
        const widths = await evaluate<[number, number]>(`[${visible(".record-layout .panel")}[0].getBoundingClientRect().width,${visible(".workspace-content")}[0].getBoundingClientRect().width]`);
        assert.ok(widths[0] > widths[1] * 0.8, `${name} list spans the page (${widths.join(", ")})`);
        assert.equal(await evaluate(`getComputedStyle(${visible("tbody tr:last-child td")}[0]).borderBottomStyle`), "none", "no divider under the last row");
      }
      await snapshot(`restored-${name}`);
    }
    process.stdout.write(`${current === null ? "Fresh installation" : `Login page of ${current}`} restored ${shop} from a supplied backup\n`);
  } else if (phase === "readme-screenshots") {
    // Runs after restore-file on the same profile: English, light theme, a till with a filled cart, then the busiest screens.
    nativeTheme.themeSource = "light";
    await wait("document.querySelector('#local-secret')!==null || document.querySelector('.nav-item')!==null", "restored shop reopens");
    if (await evaluate<boolean>("document.querySelector('#local-secret')!==null")) {
      await fill("#local-secret", "135790"); await submit("#local-secret"); await wait("document.querySelector('.nav-item')!==null", "restored shop opens");
    }
    await clickVisible(".language-switch button", "EN"); await wait(`${visible(".nav-item")}.some(element=>element.textContent.includes("Till"))`, "English labels");
    await navigate("Till"); await wait(`${visible(".product-tile")}.length>8`, "till products");
    for (const index of [0, 2, 5, 7]) { await evaluate(`${visible(".product-tile")}[${index}].click()`); await new Promise(resolve => setTimeout(resolve, 300)); }
    await wait(`${visible(".cart-line")}.length>=3`, "cart lines");
    await evaluate("document.activeElement?.blur()"); await snapshot("desktop-till");
    nativeTheme.themeSource = "dark"; await wait("window.matchMedia('(prefers-color-scheme: dark)').matches"); await snapshot("desktop-till-dark");
    nativeTheme.themeSource = "light"; await wait("!window.matchMedia('(prefers-color-scheme: dark)').matches");
    for (const [label, name] of [["Analytics", "analytics"], ["Reports", "reports"], ["Products & stock", "products"]] as const) {
      await navigate(label); await wait(`${visible(".section-heading h1")}.length>0`, `${name} heading`);
      // The demo history ends before today, so reports show the month rather than the default day.
      if (name === "reports") await clickVisible("button", "This month");
      // Charts and report totals load asynchronously after the section mounts.
      await new Promise(resolve => setTimeout(resolve, 1500));
      // Analytics leads with filters and totals; scroll so the first chart shows as well.
      await evaluate(name === "analytics" ? "window.scrollTo(0, 230)" : "window.scrollTo(0, 0)");
      await snapshot(`desktop-${name}`);
    }
    process.stdout.write("README screenshots captured\n");
  } else throw new Error("unknown workflow smoke phase");
}
