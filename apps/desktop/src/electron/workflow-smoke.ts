import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";

/** Disposable actual Electron DOM/IPC/native-vault workflow; invoked only by the explicit smoke flag. */
export async function runDesktopWorkflowSmoke(window: BrowserWindow, phase: string): Promise<void> {
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const wait = async (condition: string, diagnostic = "screen transition"): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const alerts = await evaluate<string>("Array.from(document.querySelectorAll('[role=alert]')).filter(element=>element.offsetParent!==null).map(element=>element.textContent).join(' | ')");
    process.stderr.write(`Desktop workflow timed out: ${diagnostic}${alerts === "" ? "" : ` (visible alerts: ${alerts})`}\n`);
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
  const clickVisible = async (selector: string, label?: string): Promise<void> => {
    await evaluate(`${visible(selector)}.find(element=>${label === undefined ? "true" : `element.textContent.trim()===${JSON.stringify(label)}`}).click()`);
  };
  const navigate = async (name: string): Promise<void> => { await evaluate(`Array.from(document.querySelectorAll('.nav-item')).find(element=>element.textContent.includes(${JSON.stringify(name)})).click()`); };
  if (phase === "create") {
    await wait("document.querySelector('#shop-name')!==null");
    await evaluate("Array.from(document.querySelectorAll('.language-switch button')).find(element=>element.textContent==='EN').click()");
    for (const [selector, value] of [["#shop-name", "Desktop validation"], ["#owner-name", "Owner"], ["#device-name", "Till"], ["#cash-name", "Cash"], ["#local-secret", "654321"], ["#confirm-secret", "654321"]]) await fill(selector!, value!);
    await submit("#local-secret");
    await wait("document.querySelector('dialog[open]')!==null"); await click("dialog button");
    await wait("document.querySelector('#till-search')!==null");
    await navigate("Products & stock"); await click(".section-heading .primary");
    for (const [selector, value] of [["#product-name", "Rice"], ["#product-unit", "bag"], ["#product-barcode", "123456789"], ["#product-price", "500"], ["#product-cost", "300"], ["#opening-stock", "3"]]) await fill(selector!, value!);
    await click(".form-panel input[type=checkbox]");
    await navigate("Till"); await navigate("Products & stock");
    assert.equal(await evaluate("document.querySelector('#product-name').value"), "Rice");
    await submit("#product-name");
    await wait("document.querySelector('#product-name')===null && document.querySelector('tbody')?.textContent.includes('Rice')");
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
    await wait("document.querySelector('.total-line')?.textContent.includes('250')");
    if (process.env["KOLO_DESKTOP_SMOKE_SCREENSHOT"] !== undefined) {
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))");
      await writeFile(process.env["KOLO_DESKTOP_SMOKE_SCREENSHOT"], (await window.webContents.capturePage()).toPNG());
    }
    await click(".checkout"); await wait("document.querySelector('.receipt-paper')?.textContent.includes('250')");
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
    await wait("document.querySelectorAll('.detail-layout tbody tr').length===4", "stock history");
    await press(".detail-heading button", "Edit"); await fill("#edit-name", "Rice 25kg"); await submit("#edit-name");
    await wait("document.querySelector('.detail-layout h2')?.textContent==='Rice 25kg' && document.querySelector('#edit-name')===null", "product edit");
    await press(".tabs button", "Categories"); await fill("#category-name", "Grain"); await submit("#category-name");
    await wait("Array.from(document.querySelectorAll('tbody')).some(element=>element.textContent.includes('Grain'))", "category created");
    // Credit: a customer with a limit buys with part payment, then pays some of the balance.
    await navigate("Customers"); await click(".section-heading .primary"); await fill("#customer-name", "Awa"); await fill("#customer-limit", "1000"); await submit("#customer-name");
    await wait("(()=>{const v=s=>Array.from(document.querySelectorAll(s)).filter(e=>e.offsetParent!==null);return v('.detail-layout h2')[0]?.textContent==='Awa';})()", "customer created");
    await navigate("Till"); await wait("document.querySelector('.product-tile')?.textContent.includes('Rice 25kg')", "edited product in till");
    await click(".product-tile"); await fill("#customer-search", "Aw"); await wait("document.querySelector('.customer-results button')!==null", "customer search");
    await click(".customer-results button"); await wait("document.querySelector('.customer-choice')?.textContent.includes('Awa')", "customer chosen");
    await fill(".payment-row input", "200"); await wait("Array.from(document.querySelectorAll('.settlement-line')).some(element=>element.textContent.includes('300'))", "credit remainder");
    await fill("#cash-received", "500"); await wait("document.querySelector('.change-line')?.textContent.includes('300')", "change due");
    await click(".checkout"); await wait("document.querySelector('.receipt-paper')?.textContent.includes('Awa') && document.querySelector('.receipt-owing')?.textContent.includes('300')", "credit receipt");
    await navigate("Customers"); await wait("(()=>{const v=s=>Array.from(document.querySelectorAll(s)).filter(e=>e.offsetParent!==null);return v('.facts')[0]?.textContent.includes('300');})()", "customer balance");
    await fill("#payment-amount", "100"); await submit("#payment-amount");
    await wait("(()=>{const v=s=>Array.from(document.querySelectorAll(s)).filter(e=>e.offsetParent!==null);return v('.notice.success').length===1 && v('.facts')[0]?.textContent.includes('200') && v('.detail-layout tbody tr').length===2;})()", "customer payment");
    // Purchase: a supplier delivery received at cost, part paid at the door and the rest owed.
    await navigate("Purchases & suppliers"); await clickVisible(".tabs button", "Suppliers"); await clickVisible(".actions.spaced button");
    await fill("#supplier-name", "Grossiste"); await submit("#supplier-name"); await wait(`${visible(".detail-layout h2")}[0]?.textContent==='Grossiste'`, "supplier created");
    await clickVisible(".tabs button", "Purchases"); await clickVisible(".section-heading .primary");
    await fill("#supplier-search", "Gro"); await wait(`${visible(".customer-results button")}.length===1`, "supplier search"); await clickVisible(".customer-results button");
    await fill("#purchase-product", "Rice"); await wait(`${visible(".customer-results button")}.length===1`, "product search"); await clickVisible(".customer-results button");
    await fill(".purchase-form .cell-input", "5"); await fill(".purchase-form td:nth-child(3) .cell-input", "300"); await fill("#purchase-paid", "500");
    await wait(`${visible(".purchase-form .settlement-line")}[0]?.textContent.includes('1,000')`, "supplier payable");
    await submit("#purchase-reference"); await wait("document.querySelector('.purchase-form')===null && document.querySelector('.receipt-layout tbody tr')!==null", "purchase recorded");
    await clickVisible(".tabs button", "Suppliers"); await wait(`${visible(".facts dd")}[0]?.textContent.replace(/[^0-9-]/g,'')==='1000'`, "supplier balance");
    // Money: cash in, a count that is short and its correction, then an expense from the till.
    await navigate("Accounts & expenses"); await clickVisible(".row-link", "Cash"); await wait(`${visible(".facts dd")}[0]?.textContent.replace(/[^0-9-]/g,'')==='50'`, "cash balance");
    await fill("#money-amount", "1000"); await fill("#money-reason", "Float"); await submit("#money-amount"); await wait(`${visible(".facts dd")}[0]?.textContent.replace(/[^0-9-]/g,'')==='1050'`, "money in");
    await fill("#cash-counted", "1000"); await submit("#cash-counted"); await wait(`${visible(".facts.compare")}[0]?.textContent.includes('-50')`, "cash compared");
    await fill("#cash-correction-reason", "Shortage"); await submit("#cash-correction-reason"); await wait(`${visible(".facts")}[0]?.textContent.includes('1,000')`, "cash corrected");
    await clickVisible(".tabs button", "Expenses"); await fill("#expense-amount", "200"); await fill("#expense-description", "Charcoal"); await submit("#expense-amount");
    await wait(`${visible("tbody tr")}.some(row=>row.textContent.includes('200'))`, "expense recorded");
    await clickVisible(".tabs button", "Accounts"); await wait(`${visible(".facts dd")}[0]?.textContent.replace(/[^0-9-]/g,'')==='800'`, "balance after expense");
    // Reports: today's summary reflects the two sales (250 + 500) and the expense.
    await navigate("Reports"); await wait("document.querySelector('.stat-tile strong')?.textContent.replace(/[^0-9-]/g,'')==='750'", "sales report");
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.stat-tile')).find(tile=>tile.textContent.startsWith('Expenses'))?.textContent.replace(/[^0-9-]/g,'')"), "200");
    // Return: one bag of the credit sale comes back; its value is credited to the customer.
    await navigate("Receipts"); await clickVisible(".receipt-choice"); await wait(`${visible(".receipt-paper")}[0]?.textContent.includes('Awa')`, "credit receipt");
    await clickVisible(".receipt-paper button", "Return items"); await wait(`${visible(".return-form .cell-input")}.length===1`, "return form");
    await fill(".return-form .cell-input", "1"); await wait(`${visible(".return-form .total-line")}[0]?.textContent.replace(/[^0-9]/g,'')==='500'`, "return preview");
    await fill("#return-reason", "Damaged"); await submit("#return-reason");
    await wait(`document.querySelector('.return-form')===null && ${visible(".receipt-paper")}[0]?.textContent.includes('Returned')`, "return recorded");
    if (process.env["KOLO_DESKTOP_SMOKE_REPORT_SCREENSHOT"] !== undefined) await writeFile(process.env["KOLO_DESKTOP_SMOKE_REPORT_SCREENSHOT"], (await window.webContents.capturePage()).toPNG());
    assert.equal(await evaluate("document.querySelector('.notice.error')===null"), true);
    await click(".topbar-actions .secondary"); await wait("document.querySelector('#local-secret')!==null");
    process.stdout.write("Actual Electron DOM setup, protected credentials, product/opening stock, barcode, fractional cash checkout, saved receipt, stock movement/count, product edit, category, credit sale, customer payment, supplier purchase, cash count/correction, expense, reports and sale return passed\n");
  } else if (phase === "reopen") {
    await wait("document.querySelector('#local-secret')!==null");
    const state = await evaluate<string>("window.kolo.getWorkspace().then(result=>result.value.state)"); assert.equal(state, "locked");
    await fill("#local-secret", "654321"); await submit("#local-secret");
    await wait("document.querySelector('#till-search')!==null");
    await navigate("Receipts"); await wait("document.querySelector('.receipt-choice')!==null"); await click(".receipt-choice");
    await wait("document.querySelector('.receipt-paper')?.textContent.includes('Awa')");
    const stateAfter = await evaluate<{ stock: number; total: number }>(`(async()=>{const {sessionId}=(await window.kolo.getWorkspace()).value;const history=(await window.kolo.listReceipts({sessionId})).value;return {stock:(await window.kolo.listProducts({sessionId})).value.items[0].onHandThousandths,total:(await window.kolo.getReceipt({sessionId,saleId:history.items[0].id})).value.totalMinor};})()`);
    assert.deepEqual(stateAfter, { stock: 9000, total: 500 });
    process.stdout.write("Actual Electron process restart, locked boot, credential unlock and persisted receipt/stock passed\n");
  } else throw new Error("unknown workflow smoke phase");
}
