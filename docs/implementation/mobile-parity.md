# Mobile parity with desktop

Status (2026-10-10): software stages A–G are implemented on the existing Expo app and pass
Node tests, typechecks and the Metro Android export. Stage H (installed Android acceptance)
has not run, so every "Device" verification below is still open. This page is the parity checklist. A row is
complete only when its success path, failure path, restart behaviour and authorization are
covered. "Node" means real-SQLite tests in `packages/core` or `apps/mobile`; "Device" means
the installed Android procedure in [F4 native validation](f4-native-validation.md) and
§"Installed acceptance" below. Node tests and Metro bundling never prove native behaviour.

The desktop reference is the current code (`apps/desktop/src/shared/service.ts` and
`apps/desktop/src/renderer/components`), not older prose: the desktop entry offers
*Create a shop* or *Import a file*; the three-choice welcome paragraph in
[desktop.md](desktop.md) is historical.

## Platform differences kept on purpose

| Topic | Desktop | Mobile |
|---|---|---|
| Session | "Stay signed in" (on by default) | Same option, on by default (keystore-held remembered user, resumed only if still valid). Off: boots locked and locks when the user leaves the app; pickers/share/print opened by KOLO keep the session (no time limit). |
| Transfer limits | One limit: 1 GiB snapshot ([ADR-035](../adr/ADR-035-binary-encrypted-container.md)) | Same |
| Photo limits | 256 MiB shop total, 64 KiB / 512 px per photo | Same |
| Local-network QR / direct sync | Hosts local pairing and encrypted sync; a new PC joins by pasted link | Scans the local QR and syncs as a foreground client; host IP can be edited |
| Bluetooth / server sync | Bluetooth remains roadmap; optional encrypted server sync is available | Same; encrypted file exchange stays |
| Photos across devices | Device-local, in backups | Same; pairing does not carry photos |
| Receipt output | OS print dialog (72 mm stylesheet) | OS share (text) and system print/PDF (`expo-print`); thermal printer adapters remain hardware work |
| Report output | Save as PDF (A4, core `reportHtml`) | System print/PDF of the same A4 page (`expo-print`), read again with the full 500-row limit; both need `data.export` |
| Legal/About | Electron licence listing, uninstall notes | Android-relevant About and licence text only |

## Navigation map

Four primary destinations, filtered by permission, in fixed order: **Sell**, **Products**,
**Activity**, **More**. Phones use a bottom bar; widths ≥ 600 dp use a side rail and show
list/detail (and catalogue/cart) side by side. Each destination is a stack: list → detail →
action. Back closes a sheet, then pops the stack, then returns to the first permitted
destination, then leaves the app.

## Action checklist

| Desktop action (`ShopService`) | Mobile destination | Permission (core-enforced) | Shared operation | Verification |
|---|---|---|---|---|
| createShop / finishSetup | Entry → Create a shop (2 steps) → recovery key | none (empty install) | `identity/workspace.createWorkspace`, `resumeWorkspaceProvisioning` | Node (core identity); Device F1 |
| unlock / lock | Entry → Unlock; More → Lock | membership | `unlockWorkspace`, `lockWorkspace` | Device F1 |
| recoverAccess | Entry → Forgot your code? | recovery key | `recoverOwnerAccess` | Node; Device F1 |
| startNewShop (legacy) | Entry (legacy state) → migrate | owner proof | `adoptLegacyWorkspace` | Device F1 |
| chooseImportFile / openBackup / restoreBackup | Entry → Import a file; More → Backup & devices → Restore | business.settings (replace) | `previewBackup`, `restoreWorkspace` | Node (backup); Device F3 |
| openInvite / acceptInvite / completePairing / cancelPairing | Entry → Import a file (invite); Backup & devices → Join | none / owner | `application/pairing` | Node; Device F3 |
| saveInvite / openPairingRequest / approvePairingRequest | Backup & devices → Add a till | business.settings | `createPairingInvite`, `confirmPairing` | Node; Device F3 |
| saveExchange / openExchange / importExchange | Backup & devices → Send / Receive changes | business.settings | `application/file-exchange` | Node; Device F3 |
| saveImportReceipt / openImportReceipt | Backup & devices → Confirmations | business.settings | `exportReceipt`, `importReceipt` | Node; Device F3 |
| retryExchange / exchangeState | Backup & devices → Pending & diagnostics | business.settings | `retryDeferred`, `exchangeDiagnostics` | Node |
| saveBackup (includePhotos) | Backup & devices → Create backup | business.settings | `createBackup` | Node; Device F3 |
| recoveryKey | Backup & devices → Recovery key | owner + code | `ownerRecoveryCode` | Device F1 |
| listProducts / getProduct / scanProduct | Sell → product selection; Products → catalogue | products.view | `queries.products`, `scannedProduct` | Node |
| createProduct / updateProduct / setProductActive | Products → New / Detail → Edit / Archive | products.create / edit / archive / price | `saveProduct` (version conflict → reload) | Node |
| productPhoto / setProductPhoto / removeProductPhoto / photoUsage | Products → Detail → Photo; Settings → Photo storage | products.view / products.edit | `application/photos` | Node; Device (picker/manipulator) |
| listCategories / createCategory / updateCategory | Products → Categories | products.view / create / edit / archive | `saveCategory` | Node |
| moveStock (opening/addition/damage) | Products → Detail → Add stock / Damage | inventory.adjust | `adjustStock` | Node |
| countStock | Products → Detail → Count stock | inventory.count | `countStock` | Node |
| stockHistory | Products → Detail → History | inventory.view | `queries.stockHistory` | Node |
| listPaymentAccounts | Payment / collections pickers | sales.create / customers.pay / purchases.pay | `paymentAccounts` (names only) | Node |
| checkout | Sell → Cart → Payment | sales.create, sales.discount, customers.credit(_override) | `completeSale` with stable sale/event IDs | Node; Device |
| getReceipt / listReceipts | Sell → saved receipt; Activity → Sales | sales.view / sales.view_own | `receipt`, `receipts` | Node |
| listCustomers / getCustomer / create / update / statement | More → Customers → Detail | customers.view / manage | `saveCustomer`, `statement` | Node |
| receiveCustomerPayment | Customer detail → Collect | customers.pay | `receiveCustomerPayment` | Node |
| listSuppliers / getSupplier / create / update / statement | More → Suppliers → Detail | suppliers.view / manage | `saveSupplier`, `statement` | Node |
| paySupplier | Supplier detail → Pay | purchases.pay | `paySupplier` | Node |
| recordPurchase / listPurchases / getPurchase | Activity → Purchases → New (supplier → items → payment) / Detail | purchases.create / pay / view | `recordPurchase`, `purchases` | Node |
| listAccounts / createAccount / updateAccount | More → Accounts → Detail | finance.accounts.view+cash.view / manage | `saveAccount` | Node |
| moveMoney / transferMoney | Account detail → Money in / out / Transfer | cash.move | `moveCash` | Node |
| countCash / correctCash | Account detail → Count → Correct (reason) | cash.count / cash.reconcile+cash.move | `reconcileCash`, `adjustCashToCount` | Node |
| listExpenses / recordExpense / reverseExpense | Activity → Expenses → New / Detail → Reverse | expenses.view / create | `recordExpense` (compensating) | Node |
| returnSource / previewReturn / recordReturn | Receipt or purchase detail → Return (quantities → preview → refund → confirm) | sales.refund / purchases.create+pay | `application/returns` | Node |
| report (13 kinds) | More → Reports → kind | reports.* per kind | `application/report-views.report` (shared with desktop) | Node (parity) |
| analytics | More → Analytics | reports.sales (+financial, +customers sections) | `application/report-views.analytics` (shared) | Node (parity) |
| journal | More → Operation journal (tap an entry for its record's history; Export CSV to a picked folder with data.export) | audit.view (+ data.export to export) | `application/audit.auditTrail`, `auditExport`; `domain/audit-csv` (shared) | Node (core); Device |
| listStaff / createStaff / setStaffPermission / setStaffRole / setStaffActive / resetStaffSecret | More → Staff → Member | owner (users.*) | `identity/members`, `identity/roles`, `grantPermission`, `clearPermissionOverride` | Node; Device F1 |
| listRoles / setRolePermission / resetRole | More → Staff → Roles | owner (users.*) | `identity/roles` | Node; Device F1 |
| setRememberSession | More → Settings → Stay signed in | signed-in user | `rememberMember`, `resumeWorkspace` | Node (session memory); Device |
| setLargeFiles | n/a (desktop only, ADR-027) | n/a | n/a | n/a |
| language / appearance | Entry and More → Settings | none | device preference database | Node |
| taxSettings / updateTaxSettings, paymentTerms / setShopTerms | More → Settings → Shop → Tax, Payment terms | business.settings (any member reads tax settings) | `operations.setTaxSettings`, `setPaymentTerms`; `settings.shopTaxSettings`, `shopPaymentTerms` | Node (core); Device |
| productTax / setProductTax | Products → product → Tax | products.view / products.edit | `operations.setProductTaxRule`, `settings.productTax` | Node (core); Device |
| creditStatus / setPartyTerms | More → Customers/Suppliers → person (due dates) → Payment terms | customers.* / suppliers.* | `settings.creditStatus`, `operations.setPaymentTerms` | Node (core); Device |
| notifications / markNotifications | More → Alerts (unread count on the row) | per alert kind | `notifications.notifications`, `markNotificationsRead` | Node (core); Device. Android notifications via `expo-notifications` while KOLO is open (per-phone switch in Settings and Alerts) |
| Receipt tax lines, tax report | Activity → receipt; More → Reports → Tax collected | sales.view(_own); reports.financial | `queries.receipt`, `report-views` | Node (core, receipt output); Device |
| Legal / About | More → Settings → About | none | static text | Device |

## Installed acceptance (stage H)

Not yet run. The F1/F3/F4 procedures apply, plus: the bottom bar/rail and Back rules on
every destination, light/dark/system appearance in both languages, TalkBack and 200 % font
scale on Sell/Products/Settings, photo pick/crop/replace/remove, print/PDF cancel and retry,
pickers/share/print keeping the session with "Stay signed in" off, while Home/app switch locks, and the performance budget below.

## Performance baseline

No device measurements exist. Record for a low-cost Android device (model, Android version,
RAM, build) with the `scripts/mobile-fixture.mjs` dataset (`npm run benchmark:mobile:host`) (10 000 products, 100 000
movements, long statements, event backlog): cold start to unlock, scanner lookup, name
search, checkout, report and analytics time, list scrolling frame drops, transfer peak
memory, APK size and memory after a long till session. Do not publish budgets before these
measurements exist.

Host baseline, 2026-10-10 (Node SQLite on the development PC, not a phone): name search
median 2.0 ms, scanner lookup 0.1 ms, page stock+photo batch 0.4 ms, statement page 0.2 ms,
cash checkout 1.3 ms, dashboard 5 ms, analytics (30 days) 51 ms, stock valuation 169 ms.
Valuation and analytics run after the screen paints; on a phone they may still take seconds.

Device reference, 2026-10-11 (Pixel 8 Pro, Android 17, 12 GB RAM, release APK 0.1.2, demo shop of
about 40 products; a high-end phone, not the low-cost budget target): cold launch to first frame
414–555 ms (`am start -W`, three runs); launch to the interactive Sell list about 1.5 s (screen
recording, two runs); 183 MB PSS on Sell after launch. The universal APK is 130 MB because it
carries arm64-v8a, armeabi-v7a, x86 and x86_64 libraries. The fixture below was measured on the same phone.

Fixture on device, 2026-10-11 (same Pixel 8 Pro; `npm run fixture:mobile` backup restored through the
app: 10 001 products, 100 001 movements, a customer with 2 000 credit sales). Restore: file read about
3–10 s; "Check selected backup" about 10–16 s from the entry screen and about 84 s from Backup & devices
inside an open shop; replacement about 3 s. Each step shows a spinner and what it is doing. Unlock to Sell
list about 2.7 s; cold launch to Sell about 2.0–2.9 s; 178 MB PSS. Typed search: about 0.55–0.65 s
from keystroke to updated list beyond the 250 ms debounce. Scanner lookup, cash checkout to receipt,
customer page, statement, reports menu: content in the first changed frame (no visible wait).
Analytics (30 days) 0.63 s. Times are from screen recordings, so they include rendering.
