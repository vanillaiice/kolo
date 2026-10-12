# KOLO

KOLO helps small and medium shops run the business day: selling, stock, customer
credit, suppliers, cash and reports. It is built for shops, supermarkets, boutiques,
pharmacies and wholesalers in Cameroon and across Africa.

## Screenshots

### Desktop

![The till with a sale in progress](docs/screenshots/desktop-till.png)

| Analytics | Products and stock |
| --- | --- |
| ![Analytics: revenue, profit and sales over time](docs/screenshots/desktop-analytics.png) | ![Products and stock list](docs/screenshots/desktop-products.png) |

<details><summary>Dark theme</summary>

![The till in the dark theme](docs/screenshots/desktop-till-dark.png)

</details>

### Android

| Sell | Cart | Products |
| --- | --- | --- |
| ![Sell with two products in the cart](docs/screenshots/mobile-sell-cart.png) | ![Cart with quantities, customer and total](docs/screenshots/mobile-cart.png) | ![Products list with stock](docs/screenshots/mobile-products.png) |

All images show the demo shop.

## What it does

- **Sell** at the till by searching products or entering their barcode, with discounts,
  split payments and credit sales.
- **Track stock** with deliveries, counts, adjustments and low-stock alerts.
- **Follow money** owed by customers and to suppliers, cash accounts and expenses.
- **See results** in daily sales, profit and stock reports.
- **Manage staff** with personal codes and role-based permissions.
- **Print or share receipts**, including returns.

## How it works

- **Works without internet.** Every sale and stock movement is saved on the device first.
- **Phone and computer.** Android, Windows and Linux apps share the same rules.
- **Your data stays yours.** Encrypted backups and file transfers move a shop between devices.
- **French and English**, with amounts in FCFA (XAF).
- **Online sync is optional.** A hosted or self-hosted server relays encrypted shop
  data to keep connected devices in step.

## Status

KOLO is in beta on Windows, Linux and Android; the apps cover the full shop workflow.
Camera-based product barcode scanning is not available yet. iOS and distribution
through Google Play and F-Droid are coming later. Beta
builds appear on the [Releases](https://github.com/vanillaiice/kolo/releases) page.

## Landing page

The bilingual static website lives in [apps/landing](apps/landing/README.md). Run
`npm run dev:landing` to preview it or `npm run check:landing` to build and validate
it. It includes downloads, demo screenshots, self-hosting links and promotional assets.

## For developers

The technical overview, repository layout and commands are in
[docs/README.md](docs/README.md). Product rules live in [SPECIFICATION.md](SPECIFICATION.md).

The [CLI](apps/cli/README.md) provides reports, JSON/CSV exports, backup
verification and decryption, support checks, and signed demo/performance fixtures.
Its separately paired headless till supports bulk imports, sync and scheduled exports.
Run `npm run kolo -- --help` to get started.

## License

The desktop/mobile apps, CLI, landing page and shared packages are
[GPL-3.0-only](LICENSE). The [sync server](apps/server/LICENSE) and
[operator dashboard](apps/admin/LICENSE) are AGPL-3.0-only.
