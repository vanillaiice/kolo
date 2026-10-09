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
    process.stderr.write(`Desktop workflow timed out: ${diagnostic}\n`);
    throw new Error("desktop DOM condition timed out");
  };
  const fill = async (selector: string, value: string): Promise<void> => {
    await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('missing fixture field'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  };
  const click = async (selector: string): Promise<void> => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); };
  const submit = async (selector: string): Promise<void> => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).closest('form').requestSubmit()`); };
  const press = async (scope: string, label: string): Promise<void> => { await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(scope)})).find(element=>element.textContent.trim()===${JSON.stringify(label)}).click()`); };
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
    assert.equal(await evaluate("document.querySelector('.notice.error')===null"), true);
    await click(".topbar-actions .secondary"); await wait("document.querySelector('#local-secret')!==null");
    process.stdout.write("Actual Electron DOM setup, protected credentials, product/opening stock, barcode, fractional cash checkout, saved receipt, stock movement/count, product edit and category passed\n");
  } else if (phase === "reopen") {
    await wait("document.querySelector('#local-secret')!==null");
    const state = await evaluate<string>("window.kolo.getWorkspace().then(result=>result.value.state)"); assert.equal(state, "locked");
    await fill("#local-secret", "654321"); await submit("#local-secret");
    await wait("document.querySelector('#till-search')!==null");
    await navigate("Receipts"); await wait("document.querySelector('.receipt-choice')!==null"); await click(".receipt-choice");
    await wait("document.querySelector('.receipt-paper')?.textContent.includes('250')");
    const stateAfter = await evaluate<{ stock: number; total: number }>(`(async()=>{const {sessionId}=(await window.kolo.getWorkspace()).value;const history=(await window.kolo.listReceipts({sessionId})).value;return {stock:(await window.kolo.listProducts({sessionId})).value.items[0].onHandThousandths,total:(await window.kolo.getReceipt({sessionId,saleId:history.items[0].id})).value.totalMinor};})()`);
    assert.deepEqual(stateAfter, { stock: 4000, total: 250 });
    process.stdout.write("Actual Electron process restart, locked boot, credential unlock and persisted receipt/stock passed\n");
  } else throw new Error("unknown workflow smoke phase");
}
