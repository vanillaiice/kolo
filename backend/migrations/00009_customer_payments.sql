-- Where a customer's payment went (§13, §17).
--
-- Paying off a debt is two facts, not one: the customer owes less, and the
-- business holds more cash. The first is the ledger entry that already exists;
-- this column is the second, recording which account took the money.
--
-- An account, never a payment method — that is what makes adding Orange a row
-- rather than a release (§10). The accounts table arrives with §17, so this is
-- not yet a foreign key, exactly as sale_payments.account_id is not.

-- +goose Up

ALTER TABLE customer_transactions ADD COLUMN account_id uuid;

-- Money that moved has to have moved somewhere, and money that did not move
-- must not claim an account. A payment with no account is cash nobody can find
-- the next morning; an account on a write-off says a till took money it never
-- saw.
ALTER TABLE customer_transactions
    ADD CONSTRAINT customer_transactions_account_only_when_money_moved
    CHECK ((account_id IS NOT NULL) = (type = 'PAYMENT'));

-- What each account took from customers settling their debts, which the cash
-- and financial reports sum (§18, §21).
CREATE INDEX customer_transactions_by_account
    ON customer_transactions (business_id, account_id, occurred_at)
    WHERE account_id IS NOT NULL;

-- +goose Down

DROP INDEX customer_transactions_by_account;
ALTER TABLE customer_transactions
    DROP CONSTRAINT customer_transactions_account_only_when_money_moved;
ALTER TABLE customer_transactions DROP COLUMN account_id;
