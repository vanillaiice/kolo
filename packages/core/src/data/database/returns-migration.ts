import type { Migration } from "./migrations.ts";
/** Forward-only append-only partial returns, linked to original immutable sales/purchases and predecessor. */
export const RETURNS_MIGRATION: Migration = {
  version: 20, name: "compensating partial sales and purchase returns", statements: [
    `CREATE TABLE business_returns (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), branch_id TEXT REFERENCES branches(id),
      kind TEXT NOT NULL CHECK(kind IN ('SALE','PURCHASE')), original_id TEXT NOT NULL, prior_id TEXT REFERENCES business_returns(id),
      prior_key TEXT NOT NULL CHECK(prior_key=coalesce(prior_id,'')), reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2048),
      total_minor INTEGER NOT NULL CHECK(total_minor>=0), cost_minor INTEGER NOT NULL CHECK(cost_minor>=0),
      debt_minor INTEGER NOT NULL CHECK(debt_minor>=0 AND debt_minor<=total_minor), debt_transaction_id TEXT,
      user_id TEXT NOT NULL REFERENCES users(id), device_id TEXT NOT NULL REFERENCES devices(id), occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
      UNIQUE(business_id,id), UNIQUE(business_id,kind,original_id,prior_key),
      CHECK((debt_minor=0)=(debt_transaction_id IS NULL)), CHECK(recorded_at>=occurred_at)
    ) STRICT`,
    `CREATE INDEX returns_source ON business_returns(business_id,kind,original_id)`,
    `CREATE INDEX returns_period ON business_returns(business_id,kind,occurred_at)`,
    `CREATE TABLE business_return_items (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL, return_id TEXT NOT NULL, original_item_id TEXT NOT NULL,
      product_id TEXT NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK(quantity>0), amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),
      cost_minor INTEGER NOT NULL CHECK(cost_minor>=0), movement_id TEXT NOT NULL REFERENCES inventory_movements(id),
      FOREIGN KEY(business_id,return_id) REFERENCES business_returns(business_id,id), UNIQUE(return_id,original_item_id)
    ) STRICT`,
    `CREATE INDEX returned_items_source ON business_return_items(business_id,original_item_id)`,
    `CREATE TABLE business_return_refunds (
      id TEXT PRIMARY KEY REFERENCES account_movements(id), business_id TEXT NOT NULL, return_id TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES financial_accounts(id), amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
      FOREIGN KEY(business_id,return_id) REFERENCES business_returns(business_id,id)
    ) STRICT`,
    ...["business_returns", "business_return_items", "business_return_refunds"].flatMap(table => [
      `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'returns are immutable'); END`,
      `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'returns are immutable'); END`,
    ]),
  ],
};
