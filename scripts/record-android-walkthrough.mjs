/**
 * Record the Android first-user walkthrough on a USB-connected phone: create a shop, add categories, products and
 * stock, sell (cash with change, split cash/mobile money) and sell on credit to a customer who then pays some back.
 * Usage: node scripts/record-android-walkthrough.mjs <fr|en> [output directory, default release/walkthrough]
 *
 * ERASES the KOLO app's data on the phone (`pm clear`) so the video starts from the welcome screen. The phone is
 * driven with adb (taps found by accessibility label through uiautomator, typing with `input text`, which cannot
 * type accents) and recorded with screenrecord, restarted before its 3-minute limit, then joined. "Show taps" and
 * stay-awake are switched on for the recording and restored afterwards. Set ANDROID_SERIAL to pick a phone, and
 * KOLO_WALKTHROUGH_DEBUG=1 to log each tap and scroll.
 * Writes android-<lang>.mp4, a .webp poster and English/French .vtt captions.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { captionFile, tighten } from "./walkthrough-tighten.mjs";
import { join, resolve } from "node:path";

const lang = process.argv[2];
if (lang !== "fr" && lang !== "en") throw new Error("Usage: record-android-walkthrough.mjs <fr|en> [output directory]");
const root = resolve(import.meta.dirname, ".."), output = resolve(process.argv[3] ?? join(root, "release/walkthrough"));
const work = mkdtempSync(join(tmpdir(), "kolo-android-walkthrough-")), app = "xyz.hblabs.kolo";
const serial = process.env.ANDROID_SERIAL ?? execFileSync("adb", ["devices"], { encoding: "utf8" }).split("\n").slice(1)
  .map(line => line.split("\t")).find(([id, state]) => state === "device" && !id.startsWith("emulator"))?.[0];
if (!serial) throw new Error("No USB phone in `adb devices`; connect one with USB debugging allowed.");
const sleep = ms => new Promise(done => setTimeout(done, ms));
const adb = (...args) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
const shell = (...args) => adb("shell", ...args);

/** Labels as the app shows them (accessibility descriptions or text), and what the script types; ASCII only. */
const L = {
  fr: {
    language: "Français", create: "Créer votre boutique", shopName: "Nom de la boutique", ownerName: "Nom du propriétaire", next: "Continuer",
    code: "Nouveau code", confirm: "Confirmer le nouveau code", wrote: "J’ai noté cette clé", kept: "J’ai conservé ma clé",
    tabs: { sell: "Vendre", products: "Articles", more: "Plus" }, back: "Retour", new: "Nouveau", save: "Enregistrer", name: "Nom",
    categories: "Catégories", mainCategory: "Catégorie principale", price: "Prix de vente XAF", cost: "Coût unitaire XAF", unit: "Unité", opening: "Stock initial",
    addStock: "Ajouter du stock", countStock: "Compter le stock", quantity: "Quantité", counted: "Quantité comptée", reason: "Motif",
    accounts: "Comptes &amp; caisse", customers: "Clients,", phone: "Téléphone", limit: "Limite de crédit", receive: "Encaisser le paiement",
    add: "Ajouter ", cart: "Panier", toPayment: "Passer au paiement", received: "Montant reçu", checkout: "Encaisser", split: "Plusieurs comptes",
    credit: "Crédit client", account: "Compte:", customer: "Client:", amount: "Montant XAF", addPayment: "Ajouter ce paiement",
    creditCheckout: "Enregistrer la vente à crédit", newSale: "Nouvelle vente", cash: "Caisse",
    shop: "Alimentation Chez Mama Ngono", owner: "Mama Ngono", categoryNames: ["Alimentation", "Boissons"],
    products: [
      { name: "Riz long grain 5 kg", unit: "sac", price: "4500", cost: "3800", stock: "20", category: 0 },
      { name: "Huile de palme 1 L", unit: "bouteille", price: "1500", cost: "1250", stock: "24", category: 0 },
      { name: "Coca-Cola 33 cl", unit: "canette", price: "500", cost: "350", stock: "48", category: 1 },
    ],
    delivery: "Livraison du grossiste", count: "Inventaire du rayon",
  },
  en: {
    language: "English", create: "Create your shop", shopName: "Shop name", ownerName: "Owner name", next: "Continue",
    code: "New code", confirm: "Confirm the new code", wrote: "I wrote this key down", kept: "I saved my key",
    tabs: { sell: "Sell", products: "Products", more: "More" }, back: "Back", new: "New", save: "Save", name: "Name",
    categories: "Categories", mainCategory: "Main category", price: "Selling price XAF", cost: "Unit cost XAF", unit: "Unit", opening: "Opening stock",
    addStock: "Add stock", countStock: "Count stock", quantity: "Quantity", counted: "Counted quantity", reason: "Reason",
    accounts: "Accounts &amp; cash", customers: "Customers,", phone: "Phone", limit: "Credit limit", receive: "Receive payment",
    add: "Add ", cart: "Cart", toPayment: "Go to payment", received: "Amount received", checkout: "Take", split: "Split",
    credit: "Customer credit", account: "Account:", customer: "Customer:", amount: "Amount XAF", addPayment: "Add this payment",
    creditCheckout: "Record credit sale", newSale: "New sale", cash: "Cash drawer",
    shop: "Mama Ngono Grocery", owner: "Mama Ngono", categoryNames: ["Groceries", "Drinks"],
    products: [
      { name: "Long grain rice 5 kg", unit: "bag", price: "4500", cost: "3800", stock: "20", category: 0 },
      { name: "Palm oil 1 L", unit: "bottle", price: "1500", cost: "1250", stock: "24", category: 0 },
      { name: "Coca-Cola 33 cl", unit: "can", price: "500", cost: "350", stock: "48", category: 1 },
    ],
    delivery: "Wholesaler delivery", count: "Shelf count",
  },
}[lang];

/** Captions, shown from their step until the next one; both languages are written for every video. */
const captions = {
  welcome: ["Bienvenue dans KOLO. Créons votre boutique sur ce téléphone.", "Welcome to KOLO. Let’s create your shop on this phone."],
  details: ["Donnez un nom à votre boutique et indiquez votre nom.", "Name your shop and enter your name."],
  access: ["Choisissez le code du propriétaire : il ouvre la boutique sur ce téléphone.", "Choose the owner’s code: it opens the shop on this phone."],
  recovery: ["Notez votre clé de récupération et gardez-la en lieu sûr : elle remplace un code oublié.", "Write down your recovery key and keep it safe: it replaces a forgotten code."],
  categories: ["Dans Articles, rangez d’abord vos articles par catégorie.", "In Products, first group your products into categories."],
  product: ["Ajoutez un article : nom, catégorie, prix, coût, unité et stock de départ.", "Add a product: name, category, price, cost, unit and opening stock."],
  more: ["Ajoutez-en autant que nécessaire.", "Add as many as you need."],
  delivery: ["Une livraison arrive ? Ajoutez la quantité reçue.", "A delivery arrived? Add the quantity received."],
  count: ["Vous comptez l’étagère ? Saisissez ce qu’il y a : KOLO calcule l’écart.", "Counting the shelf? Enter what is there: KOLO works out the difference."],
  account: ["Vous acceptez le Mobile Money ? Ajoutez-le comme compte dans Plus.", "Accept mobile money? Add it as an account under More."],
  sell: ["Pour vendre, touchez les articles, puis ouvrez le panier.", "To sell, tap the products, then open the cart."],
  change: ["Saisissez l’argent reçu : KOLO affiche la monnaie à rendre.", "Enter the cash received: KOLO shows the change to give back."],
  receipt: ["La vente est enregistrée et le stock mis à jour. Partagez ou imprimez le reçu.", "The sale is saved and stock updated. Share or print the receipt."],
  split: ["Le client paie en espèces et par Mobile Money ? Choisissez Plusieurs comptes.", "Paying partly in cash and partly by mobile money? Choose Split."],
  splitReceipt: ["Le reçu montre chaque paiement.", "The receipt shows each payment."],
  customer: ["Vos habitués peuvent acheter à crédit. Créez leur fiche avec un plafond.", "Regular customers can buy on credit. Create their record with a credit limit."],
  credit: ["Vente à crédit : choisissez le client dans le panier, puis ce qu’il paie aujourd’hui.", "Credit sale: choose the customer in the cart, then what they pay today."],
  owing: ["Le reçu indique ce qui reste dû.", "The receipt shows what is still owed."],
  repay: ["Quand le client rembourse, encaissez son paiement : son solde se met à jour.", "When the customer pays back, receive the payment: their balance updates."],
  done: ["Votre boutique est prête. KOLO fonctionne même sans Internet.", "Your shop is ready. KOLO works even without internet."],
};

// ---- Screen reading and input ----
function nodes() {
  shell("uiautomator", "dump", "/sdcard/kolo-ui.xml");
  const xml = adb("exec-out", "cat", "/sdcard/kolo-ui.xml");
  return [...xml.matchAll(/<node [^>]*>/g)].map(([node]) => {
    const get = key => node.match(new RegExp(`${key}="([^"]*)"`))?.[1] ?? "";
    const [x1, y1, x2, y2] = get("bounds").match(/\d+/g).map(Number);
    return { cls: get("class").split(".").at(-1), text: get("text"), desc: get("content-desc"), focused: get("focused") === "true", x1, y1, x2, y2 };
  });
}
const keyboardShown = () => /mInputShown=true/.test(shell("dumpsys", "input_method"));
const hideKeyboard = async () => { if (keyboardShown()) { shell("input", "keyevent", "4"); await sleep(450); } };
const matches = (node, label, cls) => (cls === undefined || node.cls === cls) && node.x2 > node.x1
  && (node.desc === label || node.text === label || node.desc.startsWith(label));
/**
 * The control with exactly this label, else the first whose description starts with it and does not go on with
 * another word when it is a field ("Unit" is not "Unit cost", while "New code" finds "New code (6–8 digits…)").
 * An exact match wins even off-screen (zero or cut-off bounds), so the caller scrolls to it.
 */
const findNode = (all, label, cls) => all.find(node => (cls === undefined || node.cls === cls) && (node.desc === label || node.text === label))
  ?? all.find(node => matches(node, label, cls) && !(cls === "EditText" && /^\s+\p{Ll}/u.test(node.desc.slice(label.length))));
/** Find a control by label, scrolling down (at most a few times) when it is below the visible area. */
async function locate(label, cls) {
  for (let attempt = 0; attempt < 6; attempt++) {
    // Read until the control stops moving: a scroll can still be gliding after the swipe ends.
    let node = findNode(nodes(), label, cls);
    for (let settle = 0; settle < 4 && node && (attempt > 0 || cls === "EditText"); settle++) {
      await sleep(250);
      const again = findNode(nodes(), label, cls);
      if (again && again.y1 === node.y1 && again.y2 === node.y2) break;
      node = again;
    }
    // Tabs sit in the bar at the bottom with real bounds; a field cut off below the screen also starts there.
    const tabBar = node && node.y1 >= 1460 && node.y2 > node.y1;
    // Off-screen and covered controls report cut-off bounds (bottom above top); the tab bar starts at 1460, and a
    // field must also clear the floating action bar above it (from 1350) so the tap reaches the field.
    const limit = cls === "EditText" ? 1290 : 1460;
    if (node && node.x2 > node.x1 && (tabBar || (node.y2 > node.y1 && (node.y1 + node.y2) / 2 < limit))) return node;
    await hideKeyboard();
    if (process.env.KOLO_WALKTHROUGH_DEBUG) process.stderr.write(`scroll for ${label}: ${node ? `[${node.y1},${node.y2}]` : "absent"}\n`);
    shell("input", "swipe", "360", "1000", "360", node ? "650" : "500", "900"); await sleep(700);
  }
  throw new Error(`Not on screen: ${label}`);
}
async function tap(label, cls, pause = 650) {
  // The keyboard covers the lower half and floating buttons sit above it: close it before any non-field tap,
  // and before tapping a field that would be under it.
  if (cls !== "EditText") await hideKeyboard();
  let node = await locate(label, cls);
  // With the keyboard open, the floating action bar sits just above it (from y 815), so fields lower than that are covered.
  for (let retry = 0; cls === "EditText" && retry < 3 && (node.y1 + node.y2) / 2 > 780 && keyboardShown(); retry++) { await hideKeyboard(); node = await locate(label, cls); }
  if (process.env.KOLO_WALKTHROUGH_DEBUG) process.stderr.write(`tap ${label} [${node.x1},${node.y1},${node.x2},${node.y2}] keyboard=${keyboardShown()}\n`);
  shell("input", "tap", String(Math.round((node.x1 + node.x2) / 2)), String(Math.round((node.y1 + node.y2) / 2)));
  await sleep(pause);
}
/** Tap a field, clear it, and type a few characters at a time, like a person on a phone keyboard. */
async function type(label, text, chunk = 3) {
  const existing = (await locate(label, "EditText")).text.length;
  await tap(label, "EditText", 400);
  // A closing picker can hand focus back to an earlier field; make sure the keys go to this one.
  // Focus can take a moment to move; tap once more only if it has not arrived (Back here could leave the screen).
  const focused = () => findNode(nodes(), label, "EditText")?.focused === true;
  for (let check = 0; check < 4 && !focused(); check++) {
    await sleep(350); if (check === 2) await tap(label, "EditText", 500);
  }
  if (!focused()) throw new Error(`Could not focus ${label}`);
  if (existing > 0) shell("input", "keyevent", "KEYCODE_MOVE_END", ...Array(existing + 2).fill("KEYCODE_DEL"));
  for (let i = 0; i < text.length; i += chunk) shell("input", "text", text.slice(i, i + chunk).replaceAll(" ", "%s"));
  await sleep(450);
}
async function waitFor(label, what = label) {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await sleep(300)) if (nodes().some(node => matches(node, label))) return;
  throw new Error(`Timed out waiting for ${what}`);
}
/** Open a tab at its first screen: tabs keep their history, so go back until there is no Back button. */
async function openTab(name) {
  await tap(name, "View");
  for (let depth = 0; depth < 6 && nodes().some(node => node.desc === L.back && node.y1 < 200); depth++) await tap(L.back);
}
/** Choose an item in a picker sheet. */
async function pick(field, item) {
  await tap(field, "Button", 900);
  // Builds before 0.11.1 name the default cash account in the language the app opened in, not the one chosen.
  const name = [item, ...(item === L.cash ? ["Caisse", "Cash drawer"] : [])].find(option => nodes().some(node => matches(node, option, "Button"))) ?? item;
  await tap(name, "Button", 1100);
  // Closing the list hands focus (and the keyboard) back to the last field; settle that before the next step.
  await hideKeyboard();
}

// ---- Recording: screenrecord stops after 180 s, so a new segment starts whenever one ends ----
const settings = { show_touches: shell("settings", "get", "system", "show_touches").trim() };
const segments = [], cues = [];
let recording = false, posterAt = 0;
function startSegment() {
  const remote = `/sdcard/kolo-walkthrough-${segments.length}.mp4`;
  const segment = { remote, startedAt: Date.now(), process: spawn("adb", ["-s", serial, "shell", "screenrecord", "--bit-rate", "8000000", "--time-limit", "170", remote], { stdio: "ignore" }) };
  segment.closed = new Promise(done => segment.process.once("close", done));
  segment.process.once("close", () => { if (recording) startSegment(); });
  segments.push(segment);
}
function startRecording() { recording = true; startSegment(); }
async function stopRecording() {
  recording = false;
  // Interrupt screenrecord on the phone so it finalises the file; killing the local adb client would cut it off.
  try { shell("pkill", "-INT", "screenrecord"); } catch { /* Already stopped. */ }
  await segments.at(-1).closed; await sleep(1200);
  for (const [index, segment] of segments.entries()) {
    segment.local = join(work, `segment-${index}.mp4`);
    adb("pull", segment.remote, segment.local); shell("rm", "-f", segment.remote);
    segment.duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", segment.local], { encoding: "utf8" }));
  }
  // A segment started as recording stopped can be empty; it has no duration and nothing to join.
  for (let i = segments.length - 1; i >= 0; i--) if (!(segments[i].duration > 0)) segments.splice(i, 1);
}
/** Map a wall-clock moment onto the joined video: earlier segments' lengths plus the time into its own segment. */
function videoTime(at) {
  let before = 0;
  for (const [index, segment] of segments.entries()) {
    const next = segments[index + 1];
    if (!next || at < next.startedAt) return before + Math.min(segment.duration, Math.max(0, (at - segment.startedAt) / 1000));
    before += segment.duration;
  }
  return before;
}
const caption = key => cues.push({ at: Date.now(), text: captions[key] });

try {
  // A fresh install state: the welcome screen, in the chosen language.
  shell("pm", "clear", app);
  shell("settings", "put", "system", "show_touches", "1");
  shell("svc", "power", "stayon", "usb");
  // Wake and swipe past a swipe-only lock screen (a PIN lock must be opened by hand first).
  shell("input", "keyevent", "KEYCODE_WAKEUP"); await sleep(1000); shell("input", "swipe", "360", "1300", "360", "200", "300"); await sleep(1000);
  shell("monkey", "-p", app, "-c", "android.intent.category.LAUNCHER", "1");
  await waitFor("English", "welcome");
  await tap(L.language, "RadioButton", 900);

  startRecording(); await sleep(1500);
  caption("welcome"); await sleep(2800);
  await tap(L.create, "Button", 1200); caption("details");
  await type(L.shopName, L.shop); await type(L.ownerName, L.owner);
  await tap(L.next, "Button", 1200); caption("access");
  await type(L.code, "482916", 2); await type(L.confirm, "482916", 2);
  await tap(L.create, "Button", 2500);
  await waitFor(L.kept, "recovery key"); caption("recovery"); await sleep(4500);
  await tap(L.wrote, "Switch"); await sleep(700); await tap(L.kept, "Button", 2000);

  await openTab(L.tabs.products); caption("categories");
  await tap(L.categories, "Button");
  for (const name of L.categoryNames) { await tap(L.new, "Button"); await type(L.name, name); await tap(L.save, "Button", 1000); }
  await sleep(800); await tap(L.back);
  for (const [index, product] of L.products.entries()) {
    await tap(L.new, "Button", 900);
    caption(index === 0 ? "product" : "more");
    await type(L.name, product.name);
    await pick(L.mainCategory, L.categoryNames[product.category]);
    await type(L.price, product.price); await type(L.cost, product.cost); await type(L.unit, product.unit); await type(L.opening, product.stock);
    await sleep(index === 0 ? 1000 : 400); await tap(L.save, "Button", 1300);
    // Saving opens the new product's page; return to the list.
    await sleep(index === 0 ? 1500 : 700); await tap(L.back, "Button", 900);
  }
  await sleep(1200);

  await tap(`${L.products[1].name},`, "Button", 1000); caption("delivery");
  await tap(L.addStock, "Button"); await type(L.quantity, "12"); await type(L.reason, L.delivery); await tap(L.save, "Button", 1800);
  // The form stays open with its confirmation; go back to the product.
  await tap(L.back, "Button", 900);
  caption("count");
  await tap(L.countStock, "Button"); await type(L.counted, "35"); await type(L.reason, L.count); await tap(L.save, "Button", 2500);

  await openTab(L.tabs.more); caption("account"); await sleep(600);
  await tap(L.accounts, "Button"); await tap(L.new, "Button");
  await type(L.name, "Mobile Money"); await tap("Mobile Money", "RadioButton"); await tap(L.save, "Button", 1500);

  await openTab(L.tabs.sell); caption("sell");
  await tap(`${L.add}${L.products[0].name}`, "Button"); await tap(`${L.add}${L.products[2].name}`, "Button"); await tap(`${L.add}${L.products[2].name}`, "Button");
  await sleep(600); await tap(L.cart, "Button", 1200); await sleep(1200);
  await tap(L.toPayment, "Button", 1000); caption("change");
  await type(L.received, "10000"); await hideKeyboard(); await sleep(2500);
  await tap(L.checkout, "Button", 2000); caption("receipt");
  posterAt = Date.now(); await sleep(3800);

  await tap(L.newSale, "Button", 1000);
  await tap(`${L.add}${L.products[0].name}`, "Button"); await tap(`${L.add}${L.products[1].name}`, "Button");
  await tap(L.cart, "Button", 1000); await tap(L.toPayment, "Button", 1000);
  caption("split"); await tap(L.split, "RadioButton", 900);
  await pick(L.account, L.cash); await type(L.amount, "4000"); await tap(L.addPayment, "Button", 900);
  await pick(L.account, "Mobile Money"); await tap(L.addPayment, "Button", 1500);
  await tap(L.checkout, "Button", 2000); caption("splitReceipt"); await sleep(3500);
  await tap(L.newSale, "Button", 900);

  await openTab(L.tabs.more); caption("customer");
  await tap(L.customers, "Button"); await tap(L.new, "Button");
  await type(L.name, "Awa Mbarga"); await type(L.phone, "677 12 34 56"); await type(L.limit, "20000"); await tap(L.save, "Button", 2200);

  await openTab(L.tabs.sell);
  await tap(`${L.add}${L.products[0].name}`, "Button"); await tap(`${L.add}${L.products[2].name}`, "Button"); await tap(`${L.add}${L.products[2].name}`, "Button");
  await tap(L.cart, "Button", 1000); caption("credit");
  await pick(L.customer, "Awa Mbarga"); await sleep(900);
  await tap(L.toPayment, "Button", 1000); await tap(L.credit, "RadioButton", 900);
  await pick(L.account, L.cash); await type(L.amount, "2000"); await tap(L.addPayment, "Button", 1200);
  await tap(L.creditCheckout, "Button", 2000); caption("owing"); await sleep(3800);
  await tap(L.newSale, "Button", 900);

  await openTab(L.tabs.more); caption("repay");
  await tap(L.customers, "Button"); await tap("Awa Mbarga,", "Button", 1200); await sleep(1200);
  await tap(L.receive, "Button"); await pick(L.account, L.cash); await type(L.amount, "2000"); await tap(L.save, "Button", 2500);
  await sleep(1500);
  await openTab(L.tabs.sell); caption("done"); await sleep(4000);
  await stopRecording();
} catch (error) {
  // Keep what the phone showed for diagnosis.
  writeFileSync(join(root, "release", `android-${lang}-failure.png`), execFileSync("adb", ["-s", serial, "exec-out", "screencap", "-p"]));
  throw error;
} finally {
  if (recording) { recording = false; try { shell("pkill", "-INT", "screenrecord"); } catch { /* Already stopped. */ } }
  shell("settings", "put", "system", "show_touches", settings.show_touches === "null" ? "0" : settings.show_touches);
  shell("svc", "power", "stayon", "false");
}

// Join the segments at a constant 30 fps (phones record at a variable rate), shorten the waits between steps,
// then write the poster and captions on the shortened timeline.
mkdirSync(output, { recursive: true });
const list = join(work, "segments.txt"), joined = join(work, "joined.mp4"), name = `android-${lang}`, video = join(output, `${name}.mp4`);
writeFileSync(list, segments.map(({ local }) => `file '${local}'`).join("\n"));
const ffmpeg = args => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=30,scale=720:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-an", joined]);
const shorten = tighten(joined, video, [...cues.map(cue => videoTime(cue.at)), videoTime(posterAt)]);
ffmpeg(["-ss", String(shorten(videoTime(posterAt)) + 0.5), "-i", video, "-frames:v", "1", "-c:v", "libwebp", "-quality", "82", join(output, `${name}.webp`)]);
const end = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], { encoding: "utf8" }));
for (const [index, captionLang] of ["fr", "en"].entries()) {
  writeFileSync(join(output, `${name}-${captionLang}.vtt`), captionFile(cues.map(cue => ({ at: shorten(videoTime(cue.at)), text: cue.text[index] })), end));
}
rmSync(work, { recursive: true, force: true });
process.stdout.write(`Walkthrough written to ${video} (${end.toFixed(0)} s)\n`);
