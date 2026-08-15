-- +goose Up
-- What a business sold and what it was paid (§9–§11).
--
-- A sale, its lines, its payments, and the stock movements it caused are one
-- business event written in one transaction. Half of it landing would leave a
-- till that took money for goods the ledger never released, or released stock
-- nobody paid for.
CREATE TABLE sales (
    id           UUID        PRIMARY KEY,
    business_id  UUID        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    branch_id    UUID        REFERENCES branches (id) ON DELETE RESTRICT,
    -- Optional: a cash sale at a till names nobody (§12). Required only when
    -- something is still owed, which the application enforces because it needs
    -- the payments to know.
    customer_id  UUID,
    -- What the receipt says. For people; the system uses the identifier.
    number       TEXT        NOT NULL CHECK (length(trim(number)) BETWEEN 1 AND 120),
    -- Taken off the whole sale, after the lines. A discount on the bill and a
    -- discount on a line are different things a shopkeeper does.
    discount_minor INTEGER   NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
    currency     TEXT        NOT NULL CHECK (length(currency) = 3),
    note         TEXT,
    user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    device_id    UUID        NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
    -- When the sale happened, which for a till offline for days is days ago.
    occurred_at  TIMESTAMPTZ NOT NULL,
    -- When the row was written. Reports slice on occurred_at.
    recorded_at  TIMESTAMPTZ NOT NULL,

    CHECK (recorded_at >= occurred_at)
);

-- A receipt number identifies a sale within one business, not globally.
CREATE UNIQUE INDEX sales_number_per_business ON sales (business_id, number);

-- The query every sales report starts from (§21).
CREATE INDEX sales_by_business_and_time ON sales (business_id, occurred_at DESC);
CREATE INDEX sales_by_customer ON sales (business_id, customer_id, occurred_at DESC)
    WHERE customer_id IS NOT NULL;

CREATE TABLE sale_items (
    id          UUID        PRIMARY KEY,
    sale_id     UUID        NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
    business_id UUID        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    product_id  UUID        NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    -- The product's name as it was when it sold. A receipt reprinted next year
    -- must show what was charged, and the product will have been renamed and
    -- repriced by then (§41).
    name        TEXT        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
    -- Signed thousandths, always positive here: a negative line would be a
    -- refund wearing a sale's clothes, and §41 wants that as its own
    -- compensating transaction.
    quantity    BIGINT      NOT NULL CHECK (quantity > 0),
    discount_minor INTEGER  NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
    tax_rate_basis_points INTEGER NOT NULL DEFAULT 0
                          CHECK (tax_rate_basis_points BETWEEN 0 AND 10000),
    -- What the business paid for one, when it knows. Null is an honest gap:
    -- profit is reported only for the lines that have it (§6, §8).
    unit_cost_minor INTEGER CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
    currency    TEXT        NOT NULL CHECK (length(currency) = 3)
);

CREATE INDEX sale_items_by_sale ON sale_items (sale_id);
-- What a product sold, which is the other half of the inventory reports (§21).
CREATE INDEX sale_items_by_product ON sale_items (business_id, product_id);

CREATE TABLE sale_payments (
    id          UUID        PRIMARY KEY,
    sale_id     UUID        NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
    business_id UUID        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    branch_id   UUID        REFERENCES branches (id) ON DELETE RESTRICT,
    -- Where the money went. An account, never a payment type: that is what
    -- makes MTN and Orange configurable rather than hard-coded (§10). The
    -- accounts table arrives with §17, so this is not yet a foreign key.
    account_id  UUID        NOT NULL,
    -- Positive: a negative payment would be a refund, which is its own
    -- transaction referencing the original.
    amount_minor INTEGER    NOT NULL CHECK (amount_minor > 0),
    currency    TEXT        NOT NULL CHECK (length(currency) = 3),
    -- The provider's transaction number, when there is one. How a Mobile Money
    -- payment is found a week later.
    reference   TEXT,
    note        TEXT,
    user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    device_id   UUID        NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
    occurred_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,

    CHECK (recorded_at >= occurred_at)
);

CREATE INDEX sale_payments_by_sale ON sale_payments (sale_id);
-- What each account took, which the cash and financial reports sum (§18, §21).
CREATE INDEX sale_payments_by_account ON sale_payments (business_id, account_id, occurred_at);

-- +goose StatementBegin
-- Financial history is immutable (§41, ADR-007). A correction is a new
-- compensating transaction, and that holds for a migration or a support script
-- as much as for the application — which is why it is enforced here and not
-- only in the domain, exactly as the inventory ledger is.
CREATE OR REPLACE FUNCTION refuse_financial_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is immutable: record a compensating transaction', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER sales_immutable
    BEFORE UPDATE OR DELETE ON sales
    FOR EACH ROW EXECUTE FUNCTION refuse_financial_change();

CREATE TRIGGER sale_items_immutable
    BEFORE UPDATE OR DELETE ON sale_items
    FOR EACH ROW EXECUTE FUNCTION refuse_financial_change();

CREATE TRIGGER sale_payments_immutable
    BEFORE UPDATE OR DELETE ON sale_payments
    FOR EACH ROW EXECUTE FUNCTION refuse_financial_change();

-- +goose Down
DROP TRIGGER sale_payments_immutable ON sale_payments;
DROP TRIGGER sale_items_immutable ON sale_items;
DROP TRIGGER sales_immutable ON sales;
DROP FUNCTION refuse_financial_change();
DROP TABLE sale_payments;
DROP TABLE sale_items;
DROP TABLE sales;
