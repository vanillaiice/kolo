-- Who a business buys from, what it owes them, and the deliveries that put it
-- there (§14–§16).
--
-- The mirror of customers and sales, and deliberately its own tables rather than
-- a flag on those: what a customer owes the shop and what the shop owes a
-- supplier are opposite obligations, and one table with a sign would make it
-- possible to settle a customer's debt with a supplier's payment.
--
-- A purchase is not an inventory operation (§15). It raises stock and either
-- lowers a financial account or raises what is owed, which is why the movements
-- it caused, the money it paid, and the ledger entry it left are all written in
-- the transaction that writes the purchase itself.

-- +goose Up

CREATE TABLE suppliers (
    id                uuid        PRIMARY KEY,
    business_id       uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,

    name              text        NOT NULL,
    phone             text,
    address           text,
    -- The person to ask for, which for a wholesaler is not the business's name
    -- and is what a shopkeeper actually remembers (§14).
    contact           text,
    notes             text,

    active            boolean     NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL,
    updated_at        timestamptz NOT NULL,
    updated_by_device uuid        REFERENCES devices (id) ON DELETE RESTRICT,

    CONSTRAINT suppliers_name_not_blank
        CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    CONSTRAINT suppliers_phone_e164
        CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{1,14}$'),
    CONSTRAINT suppliers_updated_after_created
        CHECK (updated_at >= created_at)
);

ALTER TABLE suppliers
    ADD CONSTRAINT suppliers_business_scoped_identity UNIQUE (id, business_id);

CREATE INDEX suppliers_by_business ON suppliers (business_id, name);
CREATE INDEX suppliers_by_phone ON suppliers (business_id, phone) WHERE phone IS NOT NULL;

CREATE TABLE supplier_transactions (
    id             uuid        PRIMARY KEY,
    supplier_id    uuid        NOT NULL REFERENCES suppliers (id) ON DELETE RESTRICT,
    business_id    uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    branch_id      uuid        REFERENCES branches (id) ON DELETE RESTRICT,

    type           text        NOT NULL,
    -- Signed: positive adds to what the business owes, negative reduces it.
    amount_minor   bigint      NOT NULL,
    currency       char(3)     NOT NULL,
    -- Where a payment's money came from. Only a payment names one: goods going
    -- back reduce the bill without a franc leaving the till (§16, §17).
    account_id     uuid        REFERENCES financial_accounts (id) ON DELETE RESTRICT,

    reference_kind text,
    reference_id   text,
    reason         text,

    user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    device_id      uuid        NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
    occurred_at    timestamptz NOT NULL,
    recorded_at    timestamptz NOT NULL,

    CONSTRAINT supplier_transactions_type_known
        CHECK (type IN ('PURCHASE', 'PAYMENT', 'RETURN', 'ADJUSTMENT', 'OPENING_BALANCE')),

    CONSTRAINT supplier_transactions_amount_not_zero
        CHECK (amount_minor <> 0),

    CONSTRAINT supplier_transactions_direction
        CHECK (
            (type IN ('PURCHASE', 'OPENING_BALANCE') AND amount_minor > 0)
            OR (type IN ('PAYMENT', 'RETURN') AND amount_minor < 0)
            OR type = 'ADJUSTMENT'
        ),

    CONSTRAINT supplier_transactions_account_only_when_money_moved
        CHECK ((account_id IS NOT NULL) = (type = 'PAYMENT')),

    CONSTRAINT supplier_transactions_reason_when_required
        CHECK (type <> 'ADJUSTMENT' OR char_length(btrim(coalesce(reason, ''))) > 0),

    CONSTRAINT supplier_transactions_reference_when_required
        CHECK (type NOT IN ('PURCHASE', 'RETURN')
               OR (reference_kind IS NOT NULL AND reference_id IS NOT NULL)),

    CONSTRAINT supplier_transactions_reference_complete
        CHECK ((reference_kind IS NULL) = (reference_id IS NULL)),

    CONSTRAINT supplier_transactions_currency_uppercase
        CHECK (currency = upper(currency)),
    CONSTRAINT supplier_transactions_recorded_after_occurred
        CHECK (recorded_at >= occurred_at)
);

ALTER TABLE supplier_transactions
    ADD CONSTRAINT supplier_transactions_supplier_within_same_business
    FOREIGN KEY (supplier_id, business_id)
    REFERENCES suppliers (id, business_id) ON DELETE RESTRICT;

ALTER TABLE supplier_transactions
    ADD CONSTRAINT supplier_transactions_account_within_same_business
    FOREIGN KEY (account_id, business_id)
    REFERENCES financial_accounts (id, business_id) ON DELETE RESTRICT;

ALTER TABLE supplier_transactions
    ADD CONSTRAINT supplier_transactions_branch_within_same_business
    FOREIGN KEY (branch_id, business_id)
    REFERENCES branches (id, business_id) ON DELETE RESTRICT;

ALTER TABLE supplier_transactions
    ADD CONSTRAINT supplier_transactions_user_within_same_business
    FOREIGN KEY (user_id, business_id)
    REFERENCES users (id, business_id) ON DELETE RESTRICT;

ALTER TABLE supplier_transactions
    ADD CONSTRAINT supplier_transactions_device_within_same_business
    FOREIGN KEY (device_id, business_id)
    REFERENCES devices (id, business_id) ON DELETE RESTRICT;

CREATE INDEX supplier_transactions_by_supplier
    ON supplier_transactions (business_id, supplier_id, occurred_at, id);
CREATE INDEX supplier_transactions_by_account
    ON supplier_transactions (business_id, account_id, occurred_at)
    WHERE account_id IS NOT NULL;

CREATE TABLE purchases (
    id          uuid        PRIMARY KEY,
    business_id uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    branch_id   uuid        REFERENCES branches (id) ON DELETE RESTRICT,
    -- Optional: a crate bought at the market names nobody, and requiring a
    -- supplier would stop the stock being recorded at all.
    supplier_id uuid        REFERENCES suppliers (id) ON DELETE RESTRICT,
    -- The supplier's invoice or delivery-note number, when there is one.
    reference   text,
    note        text,

    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    device_id   uuid        NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
    -- When the stock arrived, which for a till offline for days is days ago.
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL,

    CONSTRAINT purchases_recorded_after_occurred CHECK (recorded_at >= occurred_at)
);

ALTER TABLE purchases
    ADD CONSTRAINT purchases_business_scoped_identity UNIQUE (id, business_id);

ALTER TABLE purchases
    ADD CONSTRAINT purchases_supplier_within_same_business
    FOREIGN KEY (supplier_id, business_id)
    REFERENCES suppliers (id, business_id) ON DELETE RESTRICT;

CREATE TABLE purchase_items (
    id              uuid    PRIMARY KEY,
    purchase_id     uuid    NOT NULL REFERENCES purchases (id) ON DELETE RESTRICT,
    business_id     uuid    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    product_id      uuid    NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    -- Required, unlike a sale line's: this is where a cost is learned, and a
    -- delivery with no cost tells the shop nothing about what its stock is
    -- worth (§8).
    unit_cost_minor bigint  NOT NULL CHECK (unit_cost_minor >= 0),
    -- Thousandths, always positive: goods going back are a return, which is its
    -- own transaction.
    quantity        bigint  NOT NULL CHECK (quantity > 0),
    currency        char(3) NOT NULL
);

ALTER TABLE purchase_items
    ADD CONSTRAINT purchase_items_product_within_same_business
    FOREIGN KEY (product_id, business_id)
    REFERENCES products (id, business_id) ON DELETE RESTRICT;

CREATE INDEX purchase_items_by_purchase ON purchase_items (purchase_id);
-- What a product cost over time, which is the other half of §8's valuation.
CREATE INDEX purchase_items_by_product ON purchase_items (business_id, product_id);

CREATE INDEX purchases_by_business_and_time ON purchases (business_id, occurred_at DESC);
CREATE INDEX purchases_by_supplier ON purchases (business_id, supplier_id, occurred_at DESC)
    WHERE supplier_id IS NOT NULL;

-- Financial history, immutable as everywhere else (§41, ADR-007).
CREATE TRIGGER purchases_immutable
    BEFORE UPDATE OR DELETE ON purchases
    FOR EACH ROW EXECUTE FUNCTION refuse_financial_change();

CREATE TRIGGER purchase_items_immutable
    BEFORE UPDATE OR DELETE ON purchase_items
    FOR EACH ROW EXECUTE FUNCTION refuse_financial_change();

CREATE TRIGGER supplier_transactions_immutable
    BEFORE UPDATE OR DELETE ON supplier_transactions
    FOR EACH ROW EXECUTE FUNCTION refuse_financial_change();

-- +goose Down

DROP TRIGGER supplier_transactions_immutable ON supplier_transactions;
DROP TRIGGER purchase_items_immutable ON purchase_items;
DROP TRIGGER purchases_immutable ON purchases;
DROP TABLE purchase_items;
DROP TABLE purchases;
DROP TABLE supplier_transactions;
DROP TABLE suppliers;
