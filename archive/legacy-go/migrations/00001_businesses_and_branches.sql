-- The tenant and the places it trades from (SPECIFICATION.md §42, §43).
--
-- Every other business-owned table hangs off businesses.id, which is the
-- boundary ADR-008 exists to protect.

-- +goose Up

CREATE TABLE businesses (
    id          uuid        PRIMARY KEY,
    name        text        NOT NULL,
    -- ISO 4217 code. Stored beside every amount rather than assumed, so a
    -- figure can never be reinterpreted in another currency (ADR-010).
    currency    char(3)     NOT NULL,
    active      boolean     NOT NULL DEFAULT true,
    -- Written by the domain, never by a trigger: the entity owns when it
    -- changed, and for a synced record that is not when the row was written.
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL,

    CONSTRAINT businesses_name_not_blank
        CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    CONSTRAINT businesses_currency_uppercase
        CHECK (currency = upper(currency)),
    CONSTRAINT businesses_updated_after_created
        CHECK (updated_at >= created_at)
);

CREATE TABLE branches (
    id          uuid        PRIMARY KEY,
    business_id uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    name        text        NOT NULL,
    active      boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL,

    CONSTRAINT branches_name_not_blank
        CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    CONSTRAINT branches_updated_after_created
        CHECK (updated_at >= created_at)
);

-- Deleting a business would take its financial history with it, which §40
-- forbids; ON DELETE RESTRICT above makes that a database error rather than a
-- silent cascade. Deactivation is the supported way to take a tenant out of
-- service.

-- Every listing of branches is scoped to one business, so the tenant column
-- leads the index.
CREATE INDEX branches_by_business ON branches (business_id, name);

-- +goose Down

DROP TABLE branches;
DROP TABLE businesses;
