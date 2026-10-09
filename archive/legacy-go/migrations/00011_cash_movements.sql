-- Money entering and leaving an account by someone's hand (§18).
--
-- The float at opening, cash carried to the bank, a transfer from the till to a
-- wallet, the correction after a count. Money a *sale* or a *customer payment*
-- moved is deliberately absent: those are recorded where they happened, and an
-- account's balance sums them from there. A second copy here could disagree
-- with the first, and then there would be two answers to how much is in the
-- drawer.
--
-- Append-only, like every other ledger. A count that finds the drawer short
-- does not edit yesterday; it records an adjustment saying so, which is what
-- leaves an owner able to see that the drawer was short at all.

-- +goose Up

CREATE TABLE account_movements (
    id              uuid        PRIMARY KEY,
    account_id      uuid        NOT NULL REFERENCES financial_accounts (id) ON DELETE RESTRICT,
    business_id     uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    branch_id       uuid        REFERENCES branches (id) ON DELETE RESTRICT,

    type            text        NOT NULL,
    -- Signed minor units: positive puts money in, negative takes it out.
    amount_minor    bigint      NOT NULL,
    currency        char(3)     NOT NULL,

    -- The other account in a transfer. A transfer is two rows, one against each
    -- account, because a balance sums the rows naming it and a single row could
    -- only ever be counted by one side.
    counterpart_id  uuid        REFERENCES financial_accounts (id) ON DELETE RESTRICT,
    reason          text,

    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    device_id       uuid        NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
    occurred_at     timestamptz NOT NULL,
    recorded_at     timestamptz NOT NULL,

    CONSTRAINT account_movements_type_known
        CHECK (type IN ('OPENING_BALANCE', 'CASH_IN', 'CASH_OUT',
                        'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT')),

    CONSTRAINT account_movements_amount_not_zero
        CHECK (amount_minor <> 0),

    -- Cash taken out that read as money in would make a drawer look full that
    -- is empty, and only a count would ever find it. A correction goes either
    -- way, because a count can find more or less.
    CONSTRAINT account_movements_direction
        CHECK (
            (type IN ('OPENING_BALANCE', 'CASH_IN', 'TRANSFER_IN') AND amount_minor > 0)
            OR (type IN ('CASH_OUT', 'TRANSFER_OUT') AND amount_minor < 0)
            OR type = 'ADJUSTMENT'
        ),

    CONSTRAINT account_movements_reason_when_required
        CHECK (type NOT IN ('ADJUSTMENT', 'CASH_OUT')
               OR char_length(btrim(coalesce(reason, ''))) > 0),

    -- Half a transfer is money vanishing with nothing to show where it went,
    -- and a counterpart on anything else claims a move that never happened.
    CONSTRAINT account_movements_counterpart_only_on_transfers
        CHECK ((counterpart_id IS NOT NULL) = (type IN ('TRANSFER_IN', 'TRANSFER_OUT'))),
    CONSTRAINT account_movements_counterpart_is_another_account
        CHECK (counterpart_id IS NULL OR counterpart_id <> account_id),

    CONSTRAINT account_movements_currency_uppercase
        CHECK (currency = upper(currency)),
    CONSTRAINT account_movements_recorded_after_occurred
        CHECK (recorded_at >= occurred_at)
);

-- The account, branch, user, and device all belong to the movement's business,
-- or one movement could span two tenants.
ALTER TABLE account_movements
    ADD CONSTRAINT account_movements_account_within_same_business
    FOREIGN KEY (account_id, business_id)
    REFERENCES financial_accounts (id, business_id) ON DELETE RESTRICT;

ALTER TABLE account_movements
    ADD CONSTRAINT account_movements_counterpart_within_same_business
    FOREIGN KEY (counterpart_id, business_id)
    REFERENCES financial_accounts (id, business_id) ON DELETE RESTRICT;

ALTER TABLE account_movements
    ADD CONSTRAINT account_movements_branch_within_same_business
    FOREIGN KEY (branch_id, business_id)
    REFERENCES branches (id, business_id) ON DELETE RESTRICT;

ALTER TABLE account_movements
    ADD CONSTRAINT account_movements_user_within_same_business
    FOREIGN KEY (user_id, business_id)
    REFERENCES users (id, business_id) ON DELETE RESTRICT;

ALTER TABLE account_movements
    ADD CONSTRAINT account_movements_device_within_same_business
    FOREIGN KEY (device_id, business_id)
    REFERENCES devices (id, business_id) ON DELETE RESTRICT;

-- Deriving what an account holds is a sum over its movements, and a day's cash
-- report is the same rows sliced by when the money moved.
CREATE INDEX account_movements_by_account
    ON account_movements (business_id, account_id, occurred_at, id);

CREATE TRIGGER account_movements_immutable
    BEFORE UPDATE OR DELETE ON account_movements
    FOR EACH ROW EXECUTE FUNCTION refuse_financial_change();

-- +goose Down

DROP TRIGGER account_movements_immutable ON account_movements;
DROP TABLE account_movements;
