-- What a business spends that is not stock (§19).
--
-- Rent, electricity, transport, a salary. Money leaves an account and nothing
-- arrives on a shelf, which is what separates an expense from a purchase:
-- confusing the two would make the shop's goods look more expensive than they
-- were.
--
-- Append-only, like every other financial record. An expense entered in error is
-- undone by a reversal — a second row, negative, naming the one it undoes — so
-- the day's cash still shows the mistake was made and put right.

-- +goose Up

CREATE TABLE expenses (
    id           uuid        PRIMARY KEY,
    business_id  uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    branch_id    uuid        REFERENCES branches (id) ON DELETE RESTRICT,

    category     text        NOT NULL,
    -- Where the money came from. An expense naming no account would leave the
    -- business poorer with no drawer any lighter (§17).
    account_id   uuid        NOT NULL REFERENCES financial_accounts (id) ON DELETE RESTRICT,
    -- Positive for a cost, negative for a reversal, so that summing expenses is
    -- plain addition with no rule to remember about skipping the undone ones.
    amount_minor bigint      NOT NULL,
    currency     char(3)     NOT NULL,

    description  text,
    -- The receipt or invoice number, when there is one.
    reference    text,
    -- The expense this one undoes, and null otherwise.
    reverses_id  uuid        REFERENCES expenses (id) ON DELETE RESTRICT,

    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    device_id    uuid        NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
    occurred_at  timestamptz NOT NULL,
    recorded_at  timestamptz NOT NULL,

    CONSTRAINT expenses_category_known
        CHECK (category IN ('RENT', 'ELECTRICITY', 'WATER', 'TRANSPORT', 'SALARY',
                            'PACKAGING', 'MAINTENANCE', 'INTERNET', 'MARKETING', 'OTHER')),

    CONSTRAINT expenses_amount_not_zero
        CHECK (amount_minor <> 0),

    -- A negative expense is a reversal and must say what it undoes; a cost
    -- cannot also claim to be one. Money appearing in the accounts with no
    -- explanation is the shape of a mistake nobody can trace.
    CONSTRAINT expenses_reversal_direction
        CHECK ((amount_minor < 0) = (reverses_id IS NOT NULL)),
    CONSTRAINT expenses_reversal_is_another_expense
        CHECK (reverses_id IS NULL OR reverses_id <> id),

    -- "OTHER, 15,000" is the line an owner stares at in a month's report with
    -- no way to find out what it was.
    CONSTRAINT expenses_other_says_what_it_was
        CHECK (category <> 'OTHER' OR char_length(btrim(coalesce(description, ''))) > 0),

    CONSTRAINT expenses_currency_uppercase
        CHECK (currency = upper(currency)),
    CONSTRAINT expenses_recorded_after_occurred
        CHECK (recorded_at >= occurred_at)
);

ALTER TABLE expenses
    ADD CONSTRAINT expenses_business_scoped_identity UNIQUE (id, business_id);

-- The account, branch, user, device, and the expense being reversed all belong
-- to this business, or one expense could span two tenants.
ALTER TABLE expenses
    ADD CONSTRAINT expenses_account_within_same_business
    FOREIGN KEY (account_id, business_id)
    REFERENCES financial_accounts (id, business_id) ON DELETE RESTRICT;

ALTER TABLE expenses
    ADD CONSTRAINT expenses_reversal_within_same_business
    FOREIGN KEY (reverses_id, business_id)
    REFERENCES expenses (id, business_id) ON DELETE RESTRICT;

ALTER TABLE expenses
    ADD CONSTRAINT expenses_branch_within_same_business
    FOREIGN KEY (branch_id, business_id)
    REFERENCES branches (id, business_id) ON DELETE RESTRICT;

ALTER TABLE expenses
    ADD CONSTRAINT expenses_user_within_same_business
    FOREIGN KEY (user_id, business_id)
    REFERENCES users (id, business_id) ON DELETE RESTRICT;

ALTER TABLE expenses
    ADD CONSTRAINT expenses_device_within_same_business
    FOREIGN KEY (device_id, business_id)
    REFERENCES devices (id, business_id) ON DELETE RESTRICT;

-- An expense is undone once. A second reversal of the same row would take the
-- money off the books twice.
CREATE UNIQUE INDEX expenses_reversed_once
    ON expenses (reverses_id) WHERE reverses_id IS NOT NULL;

-- What a month cost, by category, which is the report §19 exists for (§21).
CREATE INDEX expenses_by_business_and_time
    ON expenses (business_id, occurred_at DESC);
CREATE INDEX expenses_by_category
    ON expenses (business_id, category, occurred_at DESC);
-- And the arm the account balance query reads.
CREATE INDEX expenses_by_account
    ON expenses (business_id, account_id, occurred_at);

CREATE TRIGGER expenses_immutable
    BEFORE UPDATE OR DELETE ON expenses
    FOR EACH ROW EXECUTE FUNCTION refuse_financial_change();

-- +goose Down

DROP TRIGGER expenses_immutable ON expenses;
DROP TABLE expenses;
