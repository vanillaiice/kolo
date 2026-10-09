-- The people who operate a business, and how they prove who they are.
--
-- Identity and credentials are separate tables because SPECIFICATION.md §5
-- separates "Users & Roles" from "Authentication". A user exists whether or not
-- they can currently log in.

-- +goose Up

CREATE TABLE users (
    id          uuid        PRIMARY KEY,
    business_id uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    -- Null means the user works across the whole business, which is every user
    -- while the MVP ships single-branch (§42).
    branch_id   uuid        REFERENCES branches (id) ON DELETE RESTRICT,
    name        text        NOT NULL,
    role        text        NOT NULL,
    -- Per-user adjustments on top of the role's defaults. Revocation wins over
    -- a grant, which the domain applies; the schema only keeps the two lists.
    granted     text[]      NOT NULL DEFAULT '{}',
    revoked     text[]      NOT NULL DEFAULT '{}',
    active      boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL,

    CONSTRAINT users_name_not_blank
        CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    -- Roles are a fixed set, unlike permissions, which §38 requires to be
    -- configurable. Adding one is a schema change on purpose.
    CONSTRAINT users_role_known
        CHECK (role IN ('OWNER', 'MANAGER', 'CASHIER', 'INVENTORY', 'ACCOUNTANT')),
    CONSTRAINT users_updated_after_created
        CHECK (updated_at >= created_at)
);

-- A branch must belong to the same business as the user assigned to it.
-- Without this, a user could be pointed at another tenant's branch and the
-- foreign keys alone would allow it.
ALTER TABLE branches
    ADD CONSTRAINT branches_business_scoped_identity UNIQUE (id, business_id);

ALTER TABLE users
    ADD CONSTRAINT users_branch_within_same_business
    FOREIGN KEY (branch_id, business_id)
    REFERENCES branches (id, business_id) ON DELETE RESTRICT;

CREATE INDEX users_by_business ON users (business_id, name);

CREATE TABLE user_credentials (
    user_id     uuid        PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
    -- Denormalised from users so the login lookup and its uniqueness
    -- constraint are both single-table and tenant-scoped.
    business_id uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    -- E.164, normalised by the domain before it reaches here (ADR-012).
    phone       text        NOT NULL,
    -- A bcrypt hash. The PIN itself is never stored.
    pin_hash    text        NOT NULL,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL,

    CONSTRAINT user_credentials_phone_e164
        CHECK (phone ~ '^\+[1-9][0-9]{1,14}$'),
    CONSTRAINT user_credentials_pin_hash_is_bcrypt
        CHECK (pin_hash LIKE '$2%'),
    CONSTRAINT user_credentials_updated_after_created
        CHECK (updated_at >= created_at)
);

-- A phone number identifies one person within one business, not globally. The
-- same person may work for two businesses on the same number, and a global
-- constraint would let one tenant discover another's staff by collision
-- (ADR-012).
CREATE UNIQUE INDEX user_credentials_phone_per_business
    ON user_credentials (business_id, phone);

-- The credential must belong to the same business as its user, for the same
-- reason the branch constraint above exists.
ALTER TABLE users
    ADD CONSTRAINT users_business_scoped_identity UNIQUE (id, business_id);

ALTER TABLE user_credentials
    ADD CONSTRAINT user_credentials_user_within_same_business
    FOREIGN KEY (user_id, business_id)
    REFERENCES users (id, business_id) ON DELETE RESTRICT;

-- +goose Down

DROP TABLE user_credentials;
ALTER TABLE users DROP CONSTRAINT users_branch_within_same_business;
ALTER TABLE branches DROP CONSTRAINT branches_business_scoped_identity;
DROP TABLE users;
