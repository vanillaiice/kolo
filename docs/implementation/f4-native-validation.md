# F4 mobile acceptance procedure

Status: software checks and a bundled native test APK are available through
`npm run build:mobile:android`; Android shop-day/hardware/accessibility/performance
acceptance has not run. F1/F3 native gates remain required. Record actual device model,
Android version, RAM/storage, application/native build, scanner model/interface and
receipt printer/model/interface. Do not substitute Expo export for installed validation.

1. Install a development/production native build on the target low-cost Android device.
   Enable airplane mode. Choose English before setup, then create a fresh shop,
   categories/products, accounts and staff. Restart, verify the chosen language, unlock
   and verify all records without remote login. Repeat the form/error checks in French.
2. Receive a multi-line purchase with partial payment; inspect stock and supplier debt.
   Sell via cash, split accounts and customer credit. Include fractional goods and a
   permitted discount, and sell below zero. Default cashiers must be denied credit,
   financial reports, stock corrections and returns unless explicitly granted.
3. Collect customer credit, pay supplier debt, transfer money, record/reverse an expense,
   compare a cash count and then explicitly correct with a reason. Inspect ledgers and
   reports after every action and restart.
4. Return part and then the rest of discounted cash/credit sales and purchases. Verify
   cumulative francs, remaining quantity, cash refunds, debt credit, original receipts,
   net period reports and immutable history. Exchange returns out of order and twice.
   Competing returns on the same source must be visible for owner reconciliation.
5. Use the actual USB/Bluetooth keyboard scanner. Scan known, unknown and archived
   barcodes rapidly, without accepting a name-prefix result as a barcode. Verify focus,
   Enter submission, fractional quantity entry and accessibility labels/touch targets.
6. Open/reopen/share a saved receipt through an installed OS share target. Choose and
   implement/test the shop's printer adapter before claiming printed receipt acceptance.
   Cancellation, disconnected hardware and app background lock must preserve the sale.
7. Create an encrypted backup, restore on a fresh installation, and sell again. Check
   that restoration preserves the destination device’s language preference. Import
   peer files while operational screens are mounted; confirm refreshed stock/debt/
   cash/receipts, no duplicate effects and correct active-database/subscription ownership.
8. Exercise empty lists, failed queries/writes, revoked/suspended actors, TalkBack,
   large text, keyboard entry, background/foreground and hardware Back. Verify French/
   English labels and existing status messages in setup/unlock/recovery, staff, transfer
   and operational screens. Native preference read/write failure must show feedback and
   a working retry while leaving offline operations available.
9. Load a realistic multi-day catalogue/ledger. Measure cold startup, product/barcode/
   phone lookup, pagination/list scrolling, checkout/return/report time, peak memory and
   snapshot size. Record dataset/device measurements before setting budgets. Check
   long-lived till/cart behavior and that observer notifications do not cause frame loss.

The host SQLite integration fixture covers the accounting sequence and restart, and
native-interface tests cover synchronous commit notifications. It does not execute
React Native rendering, Android keystore/file/share dialogs or physical scanners/printers.
