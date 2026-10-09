-- Customers and their credit ledger (§12, §13).
--
-- A customer's balance is nowhere in this migration. What someone owes is the
-- sum of their transactions, exactly as stock is the sum of its movements, and
-- a column here would be a second version of the one number a shopkeeper and a
-- customer will actually argue about (§13, §59).
--
-- The ledger is append-only in the database and not merely in the domain, for
-- the same reason the stock ledger is: a correction has to be a compensating
-- entry even for a support script or a migration (§41, ADR-007).

-- +goose Up

CREATE TABLE customers (
    id                    uuid        PRIMARY KEY,
    business_id           uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,

    name                  text        NOT NULL,
    -- Everything below is optional. Someone putting a regular on credit at the
    -- counter should not have to fill in an address first (§12), and a customer
    -- in a village shop may have no phone at all.
    phone                 text,
    address               text,
    notes                 text,

    -- How much this customer may owe at once, and null when no limit has been
    -- set. Null and zero are deliberately different: null means the shopkeeper
    -- has not decided, zero means this customer may not have credit. Collapsing
    -- them would either refuse every regular who has never been given a limit,
    -- or extend unlimited credit to someone deliberately cut off.
    credit_limit_minor    bigint,
    credit_limit_currency char(3),

    active                boolean     NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL,
    updated_at            timestamptz NOT NULL,
    -- The device whose edit is in force. A customer is state rather than an
    -- event, so two devices editing one cannot both win, and this breaks a tie
    -- between edits stamped the same instant (ADR-015). Null for a record
    -- written before the column existed, and a null sorts below any device, so
    -- a real edit always beats one from before.
    updated_by_device     uuid        REFERENCES devices (id) ON DELETE RESTRICT,

    CONSTRAINT customers_name_not_blank
        CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    CONSTRAINT customers_phone_e164
        CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{1,14}$'),
    CONSTRAINT customers_credit_limit_complete
        CHECK ((credit_limit_minor IS NULL) = (credit_limit_currency IS NULL)),
    CONSTRAINT customers_credit_limit_not_negative
        CHECK (credit_limit_minor IS NULL OR credit_limit_minor >= 0),
    CONSTRAINT customers_credit_limit_currency_uppercase
        CHECK (credit_limit_currency IS NULL
               OR credit_limit_currency = upper(credit_limit_currency)),
    CONSTRAINT customers_updated_after_created
        CHECK (updated_at >= created_at)
);

ALTER TABLE customers
    ADD CONSTRAINT customers_business_scoped_identity UNIQUE (id, business_id);

-- The customer list and the search behind it (§12, §46).
CREATE INDEX customers_by_business ON customers (business_id, name);

-- A number is how a customer is found at the counter, but it is not an
-- identity: a household shares one phone, and refusing the second person on a
-- shared line would leave them out of the credit book they are already in on
-- paper. So this is a lookup index, not a unique one.
CREATE INDEX customers_by_phone ON customers (business_id, phone) WHERE phone IS NOT NULL;

-- A sale could name a customer before this table existed (00007), so the
-- reference is closed now rather than left as a bare identifier.
ALTER TABLE sales
    ADD CONSTRAINT sales_customer_within_same_business
    FOREIGN KEY (customer_id, business_id)
    REFERENCES customers (id, business_id) ON DELETE RESTRICT;

CREATE TABLE customer_transactions (
    id                  uuid        PRIMARY KEY,
    customer_id         uuid        NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
    business_id         uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    branch_id           uuid        REFERENCES branches (id) ON DELETE RESTRICT,

    type                text        NOT NULL,
    -- Signed minor units: positive adds to what the customer owes, negative
    -- reduces it. Summing a ledger is then plain addition, with no per-type
    -- rule to remember at every call site.
    amount_minor        bigint      NOT NULL,
    currency            char(3)     NOT NULL,

    -- What caused it — the sale a credit purchase came from, the return that
    -- reduced it — so a statement is a story a customer can be walked through
    -- (§13, §40).
    reference_kind      text,
    reference_id        text,
    reason              text,

    user_id             uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    device_id           uuid        NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,

    -- When it happened, which for a till offline for days is days ago. A
    -- statement is ordered by this, not by when the row was written.
    occurred_at         timestamptz NOT NULL,
    recorded_at         timestamptz NOT NULL,

    CONSTRAINT customer_transactions_type_known
        CHECK (type IN ('CREDIT_SALE', 'PAYMENT', 'RETURN', 'ADJUSTMENT',
                        'OPENING_BALANCE', 'WRITE_OFF')),

    -- An entry of nothing would appear on a statement saying nothing happened,
    -- which is worse than not appearing.
    CONSTRAINT customer_transactions_amount_not_zero
        CHECK (amount_minor <> 0),

    -- A payment that increased a debt is invisible in a total and unarguable in
    -- a statement, so the sign has to agree with the type here as well as in
    -- the domain. Corrections go either way, because one can be in the
    -- customer's favour or the shop's.
    CONSTRAINT customer_transactions_direction
        CHECK (
            (type IN ('CREDIT_SALE', 'OPENING_BALANCE') AND amount_minor > 0)
            OR (type IN ('PAYMENT', 'RETURN', 'WRITE_OFF') AND amount_minor < 0)
            OR type = 'ADJUSTMENT'
        ),

    -- A correction and a write-off move a debt with no purchase or payment
    -- behind them, which is exactly when the shopkeeper reading the statement
    -- months later needs to be told why (§39).
    CONSTRAINT customer_transactions_reason_when_required
        CHECK (type NOT IN ('ADJUSTMENT', 'WRITE_OFF')
               OR char_length(btrim(coalesce(reason, ''))) > 0),

    CONSTRAINT customer_transactions_reference_when_required
        CHECK (type NOT IN ('CREDIT_SALE', 'RETURN')
               OR (reference_kind IS NOT NULL AND reference_id IS NOT NULL)),

    CONSTRAINT customer_transactions_reference_complete
        CHECK ((reference_kind IS NULL) = (reference_id IS NULL)),

    CONSTRAINT customer_transactions_currency_uppercase
        CHECK (currency = upper(currency)),
    CONSTRAINT customer_transactions_recorded_after_occurred
        CHECK (recorded_at >= occurred_at)
);

-- The customer, branch, user, and device all belong to the transaction's
-- business, or one entry could span two tenants. Plain foreign keys allow that,
-- because each identifier is individually valid.
ALTER TABLE customer_transactions
    ADD CONSTRAINT customer_transactions_customer_within_same_business
    FOREIGN KEY (customer_id, business_id)
    REFERENCES customers (id, business_id) ON DELETE RESTRICT;

ALTER TABLE customer_transactions
    ADD CONSTRAINT customer_transactions_branch_within_same_business
    FOREIGN KEY (branch_id, business_id)
    REFERENCES branches (id, business_id) ON DELETE RESTRICT;

ALTER TABLE customer_transactions
    ADD CONSTRAINT customer_transactions_user_within_same_business
    FOREIGN KEY (user_id, business_id)
    REFERENCES users (id, business_id) ON DELETE RESTRICT;

ALTER TABLE customer_transactions
    ADD CONSTRAINT customer_transactions_device_within_same_business
    FOREIGN KEY (device_id, business_id)
    REFERENCES devices (id, business_id) ON DELETE RESTRICT;

-- Deriving a balance is a sum over one customer's entries, and a statement is
-- the same rows in the order things happened. Both are this index.
CREATE INDEX customer_transactions_by_customer
    ON customer_transactions (business_id, customer_id, occurred_at, id);

-- Finding the ledger entry a sale produced, which is how a credit sale is
-- traced back and how its replay is recognised.
CREATE INDEX customer_transactions_by_reference
    ON customer_transactions (business_id, reference_kind, reference_id)
    WHERE reference_kind IS NOT NULL;

-- refuse_financial_change() is the trigger 00007 defined for sales. The credit
-- ledger is financial history in the same sense, so it reuses that function
-- rather than declaring a second one that says the same thing.
CREATE TRIGGER customer_transactions_immutable
    BEFORE UPDATE OR DELETE ON customer_transactions
    FOR EACH ROW EXECUTE FUNCTION refuse_financial_change();

-- +goose Down

DROP TRIGGER customer_transactions_immutable ON customer_transactions;
DROP TABLE customer_transactions;
ALTER TABLE sales DROP CONSTRAINT sales_customer_within_same_business;
DROP TABLE customers;
