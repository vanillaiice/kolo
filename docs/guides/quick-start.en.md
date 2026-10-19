# kolo quick start

From download to your first sale in about 15 minutes. *[Version française](quick-start.fr.md)*

kolo is in **public beta**. Everything below works without internet.

## 1. Install

Download kolo from **[kolo.hblabs.xyz](https://kolo.hblabs.xyz/)**.

| Device | File | Notes |
| --- | --- | --- |
| Windows | Installer (`…-win-x64-setup.exe`) | Windows may warn about an unsigned build: choose **More info → Run anyway**. |
| Linux | AppImage or `.deb` | Make the AppImage executable (right-click → Properties → *Allow executing*), then open it. |
| Android | Universal APK | Allow your browser or file manager to install apps, then open the file. |

To update later, install the new version over the old one. Your shop is kept.

## 2. Create your shop

On a computer:

1. Open kolo and pick your **Language** (English or French).
2. Choose **Start a shop**.
3. **Your shop**: enter the **Shop name** and **Your name**. The till and cash account names are ready to use, so you only change them if you want different names.
4. **Your access**: choose a **6–8 digit code** (or a password of at least 12 characters), type it twice, then click **Create shop and open till**.
5. kolo shows your **recovery key**. Write it down or copy it somewhere safe, then click **I saved my key**.

> ⚠️ The recovery key is the only way to replace a forgotten owner code. Keep it away from the counter.

On an Android phone, the steps are the same: tap **Create your shop**, fill in the names, then choose your code.

## 3. Add your first products

Go to **Products & stock → Add product** and fill in:

- **Product name** and **Selling price · FCFA**
- **Unit cost · FCFA**: optional, but reports need it to show your profit
- **Opening stock**: how many are on the shelf today
- **Barcode**: optional. You can type or scan it at the till with a keyboard-style scanner.
- Tick **Allow fractional quantities** for goods sold by weight or volume (rice, oil…)

Click **Save product**. Add two or three more products.

## 4. Make your first sale

1. Open **Till**, search a product (or enter its barcode) and click it to add it.
2. Change the **Quantity** if needed.
3. Choose how the customer pays:
   - **Pay now**: enter **Cash received** to see the **Change due**, or split the amount across several accounts.
   - **Set as debt**: choose a customer first. The amount not paid goes on their account.
4. Click **Complete sale**. kolo opens the saved receipt: click **Print receipt** if you have a printer, then **New sale**.

Your sale stays in **Receipts**, the stock went down in **Products & stock**, and the day's total shows in **Reports**.

> 💡 Taking Mobile Money? Add an account in **Accounts & expenses → Add account** with the type **Mobile Money**. It then appears at the till.

## 5. Save a backup

Go to **Backup & devices → Encrypted backup**:

1. Choose a **File password** (at least 12 characters) and type it twice.
2. Click **Save a backup** and store the `.kolo-backup` file outside this computer, for example on a USB key or in your email.

Also click **Create a recovery key** in the same screen. Write down or print the 14 groups: they open your backups even if the password is forgotten or every till is lost. **They are shown only once.**

## 6. Optional: add your staff and your phone

**Staff**: go to **Staff → Add staff member**, enter a name, choose a **Role** (for example **Cashier**) and give them their own code. Each person signs in with their own code, and the **Journal** shows who did what. To change what a role may do, use **Staff → Roles**.

**A phone or second computer**, on the same Wi-Fi or hotspot (no internet needed):

1. On the main computer: **Backup & devices → Pair a new till → Show a code**.
2. On the phone: open kolo, tap **Join a shop** and scan the QR code. A second computer uses **Join a nearby shop** and pastes the copied link.
3. On the main computer, click **Allow**.

The code works once and expires after 10 minutes. Keep kolo open and unlocked on the main computer while the devices sync.

## Everyday tips

- **Lock** the till when you step away. On a shared computer, turn off **Settings → Stay signed in on this computer**.
- **Forgot your code?** On the unlock screen, click **Forgot your code?** and enter the owner recovery key.
- **Stock looks wrong?** Use **Count stock**. kolo records the difference instead of overwriting the stock.
- **A mistake in a sale?** Use **Return items** on the receipt. Sales are never deleted, they are corrected.

## Next steps

The detailed guide (coming soon) covers suppliers and purchases, expenses and cash counts, credit limits and payment terms, taxes, reports, returns, sync servers and full recovery.

---

Questions? Write to [contact@hblabs.xyz](mailto:contact@hblabs.xyz).

kolo · made by hblabs · [kolo.hblabs.xyz](https://kolo.hblabs.xyz/)
