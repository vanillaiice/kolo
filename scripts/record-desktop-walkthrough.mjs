/**
 * Record the desktop first-user walkthrough: create a shop, add categories, products and stock, sell (cash with
 * change, split cash/mobile money) and sell on credit to a customer who then pays some back.
 * Usage: node scripts/record-desktop-walkthrough.mjs <fr|en> [output directory, default release/walkthrough]
 *
 * Linux only. Electron runs on a private Xvfb display and is driven over the DevTools protocol with real mouse and
 * keyboard events at a human pace; ffmpeg records the display. A drawn cursor shows where each action happens. The
 * shop lives in a throwaway config directory (XDG_CONFIG_HOME), never the computer's real shop; its key goes to the
 * OS keyring as in the smoke tests. Writes desktop-<lang>.mp4, a .webp poster and English/French .vtt captions.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const lang = process.argv[2];
if (lang !== "fr" && lang !== "en") throw new Error("Usage: record-desktop-walkthrough.mjs <fr|en> [output directory]");
const root = resolve(import.meta.dirname, ".."), output = resolve(process.argv[3] ?? join(root, "release/walkthrough"));
const work = mkdtempSync(join(tmpdir(), "kolo-walkthrough-")), electron = createRequire(import.meta.url)("electron");
const display = ":86", port = 9231, size = [1920, 1080];
// 1280×850 CSS pixels at 1.27 fill the 1080-pixel height; the brand-green screen frames the window.
const scale = 1.27;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const jitter = (ms, spread = 0.35) => ms * (1 - spread / 2 + Math.random() * spread);

/** Text the script looks for or types, per interface language. */
const L = {
  fr: {
    nav: { till: "Caisse", products: "Articles & stock", customers: "Clients", accounts: "Comptes & dépenses" },
    shop: "Alimentation Chez Mama Ngono", owner: "Mama Ngono",
    categories: ["Épicerie", "Boissons"],
    products: [
      { name: "Riz parfumé 5 kg", unit: "sac", price: "4500", cost: "3800", stock: "20", category: 0 },
      { name: "Huile végétale 1 L", unit: "bouteille", price: "1500", cost: "1250", stock: "24", category: 0 },
      { name: "Coca-Cola 33 cl", unit: "canette", price: "500", cost: "350", stock: "48", category: 1 },
    ],
    delivery: "Livraison du grossiste", count: "Comptage de l’étagère",
    customer: { name: "Awa Mbarga", phone: "677 12 34 56", limit: "20000" },
  },
  en: {
    nav: { till: "Till", products: "Products & stock", customers: "Customers", accounts: "Accounts & expenses" },
    shop: "Mama Ngono’s Grocery", owner: "Mama Ngono",
    categories: ["Groceries", "Drinks"],
    products: [
      { name: "Fragrant rice 5 kg", unit: "bag", price: "4500", cost: "3800", stock: "20", category: 0 },
      { name: "Vegetable oil 1 L", unit: "bottle", price: "1500", cost: "1250", stock: "24", category: 0 },
      { name: "Coca-Cola 33 cl", unit: "can", price: "500", cost: "350", stock: "48", category: 1 },
    ],
    delivery: "Wholesaler delivery", count: "Shelf count",
    customer: { name: "Awa Mbarga", phone: "677 12 34 56", limit: "20000" },
  },
}[lang];

/** Captions, shown from their step until the next one; both languages are written for every video. */
const captions = {
  welcome: ["Bienvenue dans KOLO. Commençons par créer votre boutique.", "Welcome to KOLO. Let’s start by creating your shop."],
  details: ["Donnez un nom à votre boutique et indiquez votre nom.", "Name your shop and enter your name."],
  access: ["Choisissez le code du propriétaire : il ouvre la boutique sur cet ordinateur.", "Choose the owner’s code: it opens the shop on this computer."],
  recovery: ["Notez votre clé de récupération et gardez-la en lieu sûr : elle remplace un code oublié.", "Write down your recovery key and keep it safe: it replaces a forgotten code."],
  till: ["Voici la caisse. Le catalogue est vide : ajoutons des articles.", "This is the till. The catalogue is empty, so let’s add products."],
  categories: ["Rangez vos articles par catégorie.", "Group your products into categories."],
  product: ["Ajoutez un article : nom, unité, prix de vente, coût et stock de départ.", "Add a product: name, unit, selling price, cost and opening stock."],
  more: ["Ajoutez-en autant que nécessaire.", "Add as many as you need."],
  delivery: ["Une livraison arrive ? Ajoutez la quantité reçue.", "A delivery arrived? Add the quantity received."],
  count: ["Vous comptez l’étagère ? Saisissez ce qu’il y a : KOLO calcule l’écart et garde l’historique.", "Counting the shelf? Enter what is there: KOLO works out the difference and keeps the history."],
  account: ["Vous acceptez le Mobile Money ? Ajoutez-le comme compte.", "Accept mobile money? Add it as an account."],
  sell: ["Pour vendre, cliquez sur les articles.", "To sell, click the products."],
  change: ["Saisissez l’argent reçu : KOLO affiche la monnaie à rendre.", "Enter the cash received: KOLO shows the change to give back."],
  receipt: ["La vente est enregistrée et le stock mis à jour. Voici le reçu, à imprimer si besoin.", "The sale is saved and stock updated. Here is the receipt, ready to print if needed."],
  split: ["Le client paie en espèces et par Mobile Money ? Ajoutez un paiement.", "Paying partly in cash and partly by mobile money? Add a payment."],
  splitReceipt: ["Le reçu montre chaque paiement.", "The receipt shows each payment."],
  customer: ["Vos habitués peuvent acheter à crédit. Créez leur fiche avec un plafond.", "Regular customers can buy on credit. Create their record with a credit limit."],
  credit: ["Vente à crédit : choisissez le client et ce qu’il paie aujourd’hui ; le reste va sur son compte.", "Credit sale: choose the customer and what they pay today; the rest goes on their account."],
  owing: ["Le reçu indique ce qui reste dû.", "The receipt shows what is still owed."],
  repay: ["Quand le client rembourse, enregistrez son paiement : son solde se met à jour.", "When the customer pays back, record the payment: their balance updates."],
  done: ["Votre boutique est prête. KOLO fonctionne même sans Internet.", "Your shop is ready. KOLO works even without internet."],
};

const processes = [];
const start = (command, args, env = {}) => {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["pipe", "ignore", "inherit"] });
  processes.push(child); return child;
};

/** Minimal DevTools protocol client for the app's page. */
async function connect() {
  let page;
  for (let attempt = 0; attempt < 120 && !page; attempt++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(target => target.type === "page" && target.url.startsWith("kolo-app:")); } catch { /* Not listening yet. */ }
    if (!page) await sleep(250);
  }
  if (!page) throw new Error("The desktop app did not open its page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.addEventListener("open", done); socket.addEventListener("error", fail); });
  let id = 0; const pending = new Map();
  socket.addEventListener("message", ({ data }) => { const message = JSON.parse(data); pending.get(message.id)?.(message); pending.delete(message.id); });
  const send = (method, params = {}) => new Promise((done, fail) => {
    pending.set(++id, message => message.error ? fail(new Error(`${method}: ${message.error.message}`)) : done(message.result));
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => socket.close() };
}

const { send, close } = await (async () => {
  spawnSync("npm", ["run", "build", "-w", "@kolo/desktop"], { cwd: root, stdio: "inherit" });
  start("Xvfb", [display, "-screen", "0", `${size[0]}x${size[1]}x24`, "-nolisten", "tcp"]);
  await sleep(800);
  spawnSync("xsetroot", ["-solid", "#0c3426"], { env: { ...process.env, DISPLAY: display } });
  start(electron, ["apps/desktop", "--ozone-platform=x11", `--force-device-scale-factor=${scale}`, `--remote-debugging-port=${port}`],
    { DISPLAY: display, WAYLAND_DISPLAY: "", XDG_SESSION_TYPE: "x11", XDG_CONFIG_HOME: join(work, "config"), GTK_THEME: "Adwaita" });
  return connect();
})();

const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`Page error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  return result.result.value;
};
const waitFor = async (expression, what) => {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await sleep(80)) if (await evaluate(expression)) return;
  throw new Error(`Timed out waiting for ${what}`);
};
/** A page expression for the first visible element matching a selector and, optionally, containing text. */
const find = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.offsetParent!==null${text === undefined ? "" : `&&e.textContent.includes(${JSON.stringify(text)})`})`;

// The drawn cursor lives in the top layer (a manual popover) so it also shows over open dialogs.
const cursorSetup = `(()=>{if(document.getElementById('walkthrough-cursor'))return;
  const ns='http://www.w3.org/2000/svg',c=document.createElement('div'),svg=document.createElementNS(ns,'svg'),p=document.createElementNS(ns,'path');
  c.id='walkthrough-cursor';c.setAttribute('popover','manual');
  Object.assign(c.style,{position:'fixed',inset:'auto',left:'0px',top:'0px',margin:'0',padding:'0',border:'0',background:'transparent',overflow:'visible',width:'26px',height:'26px',pointerEvents:'none',zIndex:'2147483647'});
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','26');svg.setAttribute('height','26');
  p.setAttribute('d','M3 2l16 9.5-7 1.6-3.6 6.4z');p.setAttribute('fill','#142b21');p.setAttribute('stroke','#fff');p.setAttribute('stroke-width','1.6');p.setAttribute('stroke-linejoin','round');
  svg.append(p);c.append(svg);document.body.append(c);c.showPopover();
  window.__cursor=(x,y)=>{if(document.querySelector('dialog[open]')&&c.matches(':popover-open')){c.hidePopover();c.showPopover();}c.style.left=(x-3)+'px';c.style.top=(y-2)+'px';};
  window.__ripple=(x,y)=>{const r=document.createElement('div');r.setAttribute('popover','manual');
    Object.assign(r.style,{position:'fixed',inset:'auto',left:(x-18)+'px',top:(y-18)+'px',width:'36px',height:'36px',margin:'0',padding:'0',border:'3px solid #f1c642',borderRadius:'50%',background:'transparent',pointerEvents:'none'});
    document.body.append(r);r.showPopover();c.hidePopover();c.showPopover();
    r.animate([{transform:'scale(.4)',opacity:1},{transform:'scale(1.4)',opacity:0}],{duration:450,easing:'ease-out'}).finished.then(()=>r.remove());};})()`;

let pointer = [640, 420];
/** Move the drawn cursor and the real mouse together, eased, at a human pace. */
async function moveTo(x, y) {
  await evaluate(cursorSetup);
  const [fromX, fromY] = pointer, distance = Math.hypot(x - fromX, y - fromY), steps = Math.max(8, Math.round(Math.min(900, 250 + distance * 0.9) / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2, px = fromX + (x - fromX) * e, py = fromY + (y - fromY) * e;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
    await evaluate(`window.__cursor(${px},${py})`);
    await sleep(16);
  }
  pointer = [x, y];
}
/** Scroll an element into view, then return its centre. */
async function locate(expression, what) {
  await waitFor(`(${expression})!==undefined`, what);
  await evaluate(`(${expression}).scrollIntoView({block:'nearest',behavior:'smooth'})`);
  await sleep(350);
  return evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];})()`);
}
async function click(expression, what = expression) {
  const [x, y] = await locate(expression, what);
  await moveTo(x, y); await sleep(jitter(160));
  await evaluate(`window.__ripple(${x},${y})`);
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  await sleep(jitter(320));
}
/** Click a field (a page expression) and type into it, replacing what was there. */
async function typeInto(expression, text, pace = 75) {
  await click(expression);
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", commands: ["selectAll"] });
  for (const character of text) { await send("Input.insertText", { text: character }); await sleep(jitter(pace, 0.8)); }
  await sleep(jitter(250));
}
const type = (selector, text, pace) => typeInto(find(selector), text, pace);
/** Point at a <select> and choose an option by its text; the native list would open outside the page. */
async function choose(selector, optionText) {
  const element = find(selector), [x, y] = await locate(element, selector);
  await moveTo(x, y); await sleep(200); await evaluate(`window.__ripple(${x},${y})`);
  await evaluate(`(()=>{const s=${element};const o=[...s.options].find(o=>o.textContent===${JSON.stringify(optionText)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,o.value);s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(450);
}
const navigate = name => click(find(".nav-item", name), `menu ${name}`);
const submit = async selector => { await click(`${find(selector)}.closest('form').querySelector('button[type=submit]')`, `submit ${selector}`); };

// Recording and captions share one clock that starts with ffmpeg.
const raw = join(work, "raw.mp4");
const recorder = start("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-framerate", "30", "-video_size", `${size[0]}x${size[1]}`, "-i", display,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", raw]);
const startedAt = Date.now(), cues = [];
let posterAt = 0;
const caption = key => cues.push({ at: (Date.now() - startedAt) / 1000, text: captions[key] });

try {
  // Light appearance, like the website and README screenshots.
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await waitFor(`document.querySelector('[data-auth-action=create]')!==null`, "welcome screen");
  await sleep(1200);
  caption("welcome"); await sleep(2600);
  if (lang === "en") { await click(find(".language-switch button", "EN"), "English"); await sleep(900); }
  await click(`document.querySelector('[data-auth-action=create]')`, "create a shop");
  await waitFor(`document.querySelector('#shop-name')!==null`, "shop details");
  caption("details"); await sleep(1200);
  await type("#shop-name", L.shop); await type("#owner-name", L.owner);
  await sleep(800); await submit("#shop-name");
  await waitFor(`document.querySelector('#local-secret')!==null`, "owner access");
  caption("access"); await sleep(1500);
  await type("#local-secret", "482916", 140); await type("#confirm-secret", "482916", 140);
  await sleep(600); await submit("#local-secret");
  await waitFor(`document.querySelector('dialog[open] .recovery-code')!==null`, "recovery key");
  caption("recovery"); await sleep(1200);
  await moveTo(...await locate(`document.querySelector('dialog[open] .recovery-code')`, "recovery code")); await sleep(4200);
  await click(`document.querySelector('dialog[open] button.primary')`, "key kept");
  await waitFor(`document.querySelector('#till-search')!==null`, "till");
  caption("till"); await sleep(3200);

  await navigate(L.nav.products); caption("categories");
  await click(`${find("main .tabs button")}.parentElement.querySelectorAll('button')[1]`, "categories tab");
  for (const name of L.categories) { await type("#category-name", name); await submit("#category-name"); await sleep(700); }
  await sleep(900);
  await click(`${find("main .tabs button")}.parentElement.querySelectorAll('button')[0]`, "products tab");
  for (const [index, product] of L.products.entries()) {
    if (index === 1) caption("more");
    const pace = index === 0 ? 75 : 45;
    await click(find("main .section-heading .primary"), "add product");
    await waitFor(`document.querySelector('#product-name')!==null`, "product form");
    if (index === 0) caption("product");
    await type("#product-name", product.name, pace); await type("#product-unit", product.unit, pace);
    await choose("#product-category", L.categories[product.category]);
    await type("#product-price", product.price, pace); await type("#product-cost", product.cost, pace); await type("#opening-stock", product.stock, pace);
    await sleep(index === 0 ? 1200 : 500); await submit("#product-name");
    await waitFor(`document.querySelector('#product-name')===null`, "product saved"); await sleep(900);
  }
  await sleep(1200);

  await click(find("main .row-link", L.products[1].name), "oil detail");
  await waitFor(`document.querySelector('#movement-quantity')!==null`, "stock panel");
  caption("delivery"); await sleep(1200);
  await type("#movement-quantity", "12"); await type("#movement-reason", L.delivery, 55); await submit("#movement-quantity");
  await waitFor(`document.querySelector('.notice.success')!==null`, "delivery saved"); await sleep(2200);
  caption("count");
  await click(`document.querySelector('input[name=movement-kind][value=count]')`, "count");
  await type("#movement-quantity", "35"); await type("#movement-reason", L.count, 55); await submit("#movement-quantity");
  await waitFor(`document.querySelector('.notice.success')?.textContent.includes('-1')`, "count saved"); await sleep(3500);

  await navigate(L.nav.accounts); caption("account"); await sleep(700);
  await click(find("main button", "+"), "add account");
  await type("#account-name", "Mobile Money"); await choose("#account-kind", "Mobile Money");
  await submit("#account-name"); await waitFor(`${find("main .row-link", "Mobile Money")}!==undefined`, "account saved"); await sleep(2000);

  await navigate(L.nav.till); caption("sell"); await sleep(800);
  const tile = name => find(".product-tile", name);
  await click(tile(L.products[0].name)); await click(tile(L.products[2].name)); await click(tile(L.products[2].name)); await click(tile(L.products[2].name));
  await sleep(1000); caption("change");
  await type("#cash-received", "10000"); await sleep(2600);
  await click(`document.querySelector('.checkout')`, "finish sale");
  await waitFor(`document.querySelector('.receipt-paper')!==null`, "receipt"); caption("receipt");
  await sleep(800); posterAt = (Date.now() - startedAt) / 1000; await sleep(3600);

  await click(find("main button.primary", lang === "fr" ? "Nouvelle vente" : "New sale"), "new sale");
  await waitFor(`document.querySelector('#till-search')!==null`, "till again");
  await click(tile(L.products[0].name)); await click(tile(L.products[1].name));
  caption("split"); await sleep(900);
  await type(".payment-row input", "4000");
  await click(find("main .text-button", "+"), "add payment");
  await typeInto(`document.querySelectorAll('.payment-row')[1]?.querySelector('input')`, "2000"); await sleep(1600);
  await click(`document.querySelector('.checkout')`, "finish sale");
  await waitFor(`document.querySelector('.receipt-paper')!==null`, "split receipt"); caption("splitReceipt"); await sleep(3800);

  await navigate(L.nav.customers); caption("customer"); await sleep(700);
  await click(find("main .section-heading .primary"), "add customer");
  await type("#customer-name", L.customer.name); await type("#customer-phone", L.customer.phone); await type("#customer-limit", L.customer.limit);
  await sleep(700); await submit("#customer-name");
  await waitFor(`${find(".detail-layout h2", L.customer.name)}!==undefined`, "customer saved"); await sleep(2200);

  await navigate(L.nav.till);
  await waitFor(`document.querySelector('#till-search')!==null`, "till for credit");
  await click(tile(L.products[0].name)); await click(tile(L.products[2].name)); await click(tile(L.products[2].name));
  caption("credit"); await sleep(600);
  await type("#customer-search", "Awa"); await waitFor(`document.querySelector('.customer-results button')!==null`, "customer search");
  await click(`document.querySelector('.customer-results button')`, "pick customer");
  await click(`document.querySelector('#sale-on-debt')`, "credit sale");
  await type("#debt-received", "2000"); await sleep(2200);
  await click(`document.querySelector('.checkout')`, "finish credit sale");
  await waitFor(`document.querySelector('.receipt-owing')!==null`, "credit receipt"); caption("owing");
  await moveTo(...await locate(`document.querySelector('.receipt-owing')`, "owing")); await sleep(3600);

  await navigate(L.nav.customers); caption("repay");
  await waitFor(`${find("#payment-amount")}!==undefined`, "customer detail");
  await sleep(1400);
  await type("#payment-amount", "2000"); await submit("#payment-amount");
  await waitFor(`${find(".notice.success")}!==undefined`, "payment saved"); await sleep(3200);

  await navigate(L.nav.till); caption("done"); await sleep(4200);
} finally {
  recorder.stdin.end("q");
  await new Promise(done => recorder.once("close", done));
  close();
  for (const child of processes.reverse()) if (child.exitCode === null) child.kill();
}

// Trim the recorder's start-up and compress for the web; captions follow the same offset.
const trim = 0.6, end = (Date.now() - startedAt) / 1000;
mkdirSync(output, { recursive: true });
const name = `desktop-${lang}`, video = join(output, `${name}.mp4`);
const ffmpeg = args => { const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" }); if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed`); };
ffmpeg(["-ss", String(trim), "-i", raw, "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", video]);
ffmpeg(["-ss", String(Math.max(0, posterAt - trim)), "-i", video, "-frames:v", "1", "-vf", "scale=1280:-2", "-c:v", "libwebp", "-quality", "82", join(output, `${name}.webp`)]);
const stamp = seconds => { const s = Math.max(0, seconds - trim); return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${(s % 60).toFixed(3).padStart(6, "0")}`; };
for (const [index, captionLang] of ["fr", "en"].entries()) {
  const body = cues.map((cue, i) => `${i + 1}\n${stamp(cue.at)} --> ${stamp(Math.min(cues[i + 1]?.at ?? end, cue.at + 9))}\n${cue.text[index]}\n`).join("\n");
  writeFileSync(join(output, `${name}-${captionLang}.vtt`), `WEBVTT\n\n${body}`);
}
rmSync(work, { recursive: true, force: true });
process.stdout.write(`Walkthrough written to ${video} (${(end - trim).toFixed(0)} s)\n`);
