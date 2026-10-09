-- Where a business's money sits (§17).
--
-- Two tables have been naming an account for several migrations — sale_payments
-- since 00007, customer_transactions since 00009 — with nothing behind the
-- column. This is that something, and both references are closed at the end.
--
-- No balance column, deliberately. What an account holds is the sum of the
-- transactions touching it, and §18's whole point is comparing what the system
-- derives against what is actually in the drawer. A stored balance would make
-- that comparison meaningless: it would be both the number being checked and
-- the number checking (§59).

-- +goose Up

CREATE TABLE financial_accounts (
    id                uuid        PRIMARY KEY,
    business_id       uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    -- Optional: a till belongs to a branch, a bank account to the business (§42).
    branch_id         uuid        REFERENCES branches (id) ON DELETE RESTRICT,

    name              text        NOT NULL,
    -- How the system reasons about the account — cash is counted against a
    -- drawer, a wallet is not. Which *provider* a wallet belongs to is the
    -- name, never a kind here: that is what makes adding Orange Money a row
    -- rather than a release (§10).
    kind              text        NOT NULL,
    currency          char(3)     NOT NULL,

    -- The wallet number, bank number, or till label. Optional, because a shop
    -- with one drawer needs nothing more than "Caisse".
    number            text,
    notes             text,

    active            boolean     NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL,
    updated_at        timestamptz NOT NULL,
    -- An account is state, like a product and a customer, and settles the same
    -- way: last-write-wins ordered by (updated_at, updated_by_device), ADR-015.
    updated_by_device uuid        REFERENCES devices (id) ON DELETE RESTRICT,

    CONSTRAINT financial_accounts_name_not_blank
        CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    CONSTRAINT financial_accounts_kind_known
        CHECK (kind IN ('CASH', 'MOBILE_MONEY', 'BANK', 'CARD', 'OTHER')),
    CONSTRAINT financial_accounts_currency_uppercase
        CHECK (currency = upper(currency)),
    CONSTRAINT financial_accounts_updated_after_created
        CHECK (updated_at >= created_at)
);

ALTER TABLE financial_accounts
    ADD CONSTRAINT financial_accounts_business_scoped_identity UNIQUE (id, business_id);

-- A branch's account must be a branch of its own business, which plain foreign
-- keys allow to differ because each identifier is individually valid.
ALTER TABLE financial_accounts
    ADD CONSTRAINT financial_accounts_branch_within_same_business
    FOREIGN KEY (branch_id, business_id)
    REFERENCES branches (id, business_id) ON DELETE RESTRICT;

-- Two accounts in one business may not share a name: a cashier choosing between
-- "MTN Mobile Money" and "MTN Mobile Money" is choosing at random, and the
-- money goes to whichever they happened to tap.
CREATE UNIQUE INDEX financial_accounts_name_per_business
    ON financial_accounts (business_id, lower(btrim(name)));

CREATE INDEX financial_accounts_by_business ON financial_accounts (business_id, name);

-- The references that have been waiting for this table. A payment naming an
-- account nobody opened is money the reports cannot place.
ALTER TABLE sale_payments
    ADD CONSTRAINT sale_payments_account_within_same_business
    FOREIGN KEY (account_id, business_id)
    REFERENCES financial_accounts (id, business_id) ON DELETE RESTRICT;

ALTER TABLE customer_transactions
    ADD CONSTRAINT customer_transactions_account_within_same_business
    FOREIGN KEY (account_id, business_id)
    REFERENCES financial_accounts (id, business_id) ON DELETE RESTRICT;

-- +goose Down

ALTER TABLE customer_transactions DROP CONSTRAINT customer_transactions_account_within_same_business;
ALTER TABLE sale_payments DROP CONSTRAINT sale_payments_account_within_same_business;
DROP TABLE financial_accounts;
