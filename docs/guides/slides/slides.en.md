---
theme: default
title: kolo — Your shop, running smoothly
info: |
  Short presentation of kolo for shop visits and training sessions.
  Speaker notes (press P for presenter mode) hold the trainer script.
colorSchema: light
transition: slide-left
mdc: true
---

<div class="cover">
  <img src="/kolo-icon.svg" class="logo" alt="kolo logo" />
  <h1>Your shop.<br>Your day.<br>Under control.</h1>
  <p class="lead">Sales, stock and customer credit. Keep your shop running, even without internet.</p>
  <p class="tag">Public beta · Windows · Linux · Android · English & French</p>
</div>

<!--
Introduce yourself. One sentence: kolo is a till and shop manager for everyday shops,
made for how shops here actually work: cash, Mobile Money, credit, and unreliable internet.
-->

---
layout: two-cols
---

# The everyday problem

- Sales written in a notebook, or not at all
- Customer credit forgotten or disputed
- Nobody knows what is really on the shelf
- Profit is a guess at the end of the month
- Internet comes and goes

::right::

<div class="callout">
  <p class="big">kolo replaces the notebook.</p>
  <p>Every sale, delivery and payment is recorded once, at the counter, and the totals follow by themselves.</p>
</div>

<!--
Ask the audience: "How do you know today what each customer owes you?"
Let them answer. Most will say notebook or memory. That is the hook.
-->

---

# Three things kolo does

<div class="pillars">
  <div><h3>Sell</h3><p>Find a product, take payment, print a receipt. Discounts, split payments and credit.</p></div>
  <div><h3>Stock</h3><p>Deliveries, losses and shelf counts. Low-stock alerts before you run out.</p></div>
  <div><h3>Money</h3><p>What customers owe you, what you owe suppliers, expenses, and daily reports.</p></div>
</div>

<img src="/screens/desktop-till.png" class="shot" alt="The till with a sale in progress" />

<!--
Keep it to three words: Sell, Stock, Money. Everything else in the deck is detail under one of these.
-->

---

# Works without internet

- Every sale and stock movement is **saved on the device first**
- Selling, stock, credit and reports never wait for a connection
- Phone and computer can sync on the **same Wi-Fi or hotspot**, with no internet
- An optional sync server connects tills that are far apart

<div class="note">The connection is a bonus, not a requirement.</div>

<!--
This is the main difference from cloud tills. A power cut or a data bundle running out
does not stop the counter. Sync catches up later by itself.
-->

---
layout: two-cols
---

# Selling at the till

1. Search a product or type its barcode
2. Add a customer if needed
3. **Pay now**: cash, Mobile Money, bank or card, split if needed
4. Or **Set as debt**: the rest goes on the customer's account
5. **Complete sale** and print the receipt

Change due is calculated for you.

::right::

<img src="/screens/mobile-sell-cart.png" class="phone" alt="Selling on Android" />

<!--
Demo live if you can: two products, one customer, part cash, part Mobile Money.
Point out that the receipt can be found again later under Receipts.
-->

---
layout: two-cols
---

# Products & stock

- Name, price, cost and **opening stock** in one form
- **Add stock**, **Damage or loss**, **Count stock**
- Every change is kept in the stock history
- **Low-stock alert level** per product
- Sold by the item or by fractions (kg, litres)

::right::

<img src="/screens/desktop-products.png" class="shot" alt="Products and stock list" />

<!--
Stress: stock is never typed over. A count records the difference, so you can see
what went missing and when.
-->

---

# Customers & credit

- Each customer shows what they **owe** or have **in advance**
- **Credit limit** per customer, so cashiers can't go over it
- **Payment terms** and alerts when a payment is overdue
- A clear **statement**: sales, payments and the balance after each one
- Change can be kept as customer credit

<div class="note">No more arguing about the notebook: the statement shows every entry.</div>

<!--
For shops that sell on credit, this slide sells the product. Show a customer statement if you have demo data.
-->

---
layout: two-cols
---

# Money & reports

- Accounts: **Cash**, **Mobile Money**, **Bank**, **Card**
- Expenses: rent, electricity, transport, salaries…
- Count the cash drawer and see the difference
- Reports: sales, profit, best sellers, stock value, debts, tax (VAT), printable or saved as PDF
- Analytics: trends and busy hours

::right::

<img src="/screens/desktop-analytics.png" class="shot" alt="Analytics: revenue, profit and sales over time" />

<!--
Ask: "Do you know your profit for last week?" Most don't. kolo answers it in two clicks
if product costs are entered.
-->

---

# Staff, each with their own code

| Role | Typical use |
| --- | --- |
| Owner | Everything, including staff and devices |
| Manager | Runs the shop day to day |
| Cashier | Sells and takes payments |
| Inventory staff | Deliveries and counts |
| Accountant | Money and reports |

The owner decides what each role may do, and can make exceptions for one person. The **Journal** shows who did what, when, and on which device.

<!--
Owners worry about theft. Personal codes plus the journal answer that concern.
-->

---

# Phone and computer together

1. On the main computer: **Backup & devices → Pair a new till → Show a code**
2. On the phone: **Join a shop** and scan the QR code
3. The owner clicks **Allow**

- Same Wi-Fi or hotspot: no internet needed
- Or through a sync server, from anywhere
- Data is **encrypted** on the till before it is sent. The server cannot read sales, prices or customers.

<!--
The code works once and expires after 10 minutes. For local sync, kolo must stay open
and unlocked on the main computer.
-->

---

# Your data stays yours

- Data lives on **your** devices, not in someone else's cloud
- **Encrypted backups**, protected by a password
- **Owner recovery key**: replaces a forgotten owner code
- **Backup recovery key** (14 groups, printed once): opens your backups even if every till is lost
- Open source: apps GPL-3.0, sync server AGPL-3.0

<div class="note">Keep a backup and the key sheets away from the shop.</div>

<!--
Be honest: if the owner loses both the code and the recovery key, and has no backup,
nobody can get the data back. That is the price of real privacy.
-->

---

# Hands-on: the first 10 minutes

1. Install kolo and choose your language
2. **Start a shop**: shop name, your name, your code
3. Save the **recovery key**
4. **Add product** ×3, with opening stock
5. Make a sale, then find it in **Receipts**
6. **Save a backup**

<div class="note">Follow along with the Quick start guide.</div>

<!--
Training only: hand out the quick start (docs/guides/quick-start.en.md) and let each
participant do these steps on their own device. Walk the room.
-->

---

# Where kolo is today

- **Public beta**: Windows, Linux and Android
- Free and open-source apps; self-hosting the sync server is free
- Hosted sync service: paid subscription, contact@hblabs.xyz
- Coming later: camera barcode scanning, Google Play, F-Droid and iOS

<!--
Don't promise dates. Mention that feedback from real shops decides what comes next.
-->

---
layout: center
class: text-center
---

<img src="/kolo-icon.svg" class="logo-small" alt="kolo logo" />

# Try kolo today

<p class="lead">kolo.hblabs.xyz · contact@hblabs.xyz</p>

Download · Try it at your counter · Ask us anything

<p class="credit">kolo · made by hblabs</p>

<!--
Leave this slide up during questions. Collect contacts of shops that want help getting started.
-->
