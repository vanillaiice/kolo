-- Installations of the application, and the sessions held on them.
--
-- A session is bound to a user, a business, and a device (§28, ADR-012), so a
-- stolen token is useless on another installation and an audit record can say
-- where an action happened (§39).

-- +goose Up

CREATE TABLE devices (
    id           uuid        PRIMARY KEY,
    business_id  uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    -- Null means the device works across the whole business: an owner's phone
    -- follows them between shops, while a till stays at one.
    branch_id    uuid        REFERENCES branches (id) ON DELETE RESTRICT,
    -- What a person calls it, so a device list or an audit entry means
    -- something to the owner rather than showing an identifier.
    label        text        NOT NULL,
    platform     text        NOT NULL,
    active       boolean     NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL,
    updated_at   timestamptz NOT NULL,
    -- Advanced on contact, and deliberately not the same as updated_at: being
    -- seen is not an edit to the record.
    last_seen_at timestamptz NOT NULL,

    CONSTRAINT devices_label_not_blank
        CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
    CONSTRAINT devices_platform_known
        CHECK (platform IN ('ANDROID', 'IOS', 'WEB', 'DESKTOP')),
    CONSTRAINT devices_updated_after_created
        CHECK (updated_at >= created_at),
    CONSTRAINT devices_seen_after_created
        CHECK (last_seen_at >= created_at)
);

-- A device must be stationed at a branch of its own business, for the same
-- reason a user must be. Plain foreign keys allow the mismatch because each
-- identifier is individually valid.
ALTER TABLE devices
    ADD CONSTRAINT devices_business_scoped_identity UNIQUE (id, business_id);

ALTER TABLE devices
    ADD CONSTRAINT devices_branch_within_same_business
    FOREIGN KEY (branch_id, business_id)
    REFERENCES branches (id, business_id) ON DELETE RESTRICT;

CREATE INDEX devices_by_business ON devices (business_id, label);

CREATE TABLE sessions (
    id           uuid        PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    business_id  uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    device_id    uuid        NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
    -- A SHA-256 digest of the token, never the token itself. A disclosure of
    -- this table must not yield credentials.
    token_hash   text        NOT NULL,
    issued_at    timestamptz NOT NULL,
    expires_at   timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    -- Null while the session is live. Revocation is recorded rather than
    -- deleted, so an audit can still show the session existed (§39, §40).
    revoked_at   timestamptz,

    CONSTRAINT sessions_token_hash_is_sha256
        CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT sessions_expires_after_issued
        CHECK (expires_at >= issued_at),
    CONSTRAINT sessions_seen_after_issued
        CHECK (last_seen_at >= issued_at),
    CONSTRAINT sessions_revoked_after_issued
        CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

-- The user and the device must both belong to the session's business,
-- otherwise a session could be minted that spans two tenants.
ALTER TABLE sessions
    ADD CONSTRAINT sessions_user_within_same_business
    FOREIGN KEY (user_id, business_id)
    REFERENCES users (id, business_id) ON DELETE RESTRICT;

ALTER TABLE sessions
    ADD CONSTRAINT sessions_device_within_same_business
    FOREIGN KEY (device_id, business_id)
    REFERENCES devices (id, business_id) ON DELETE RESTRICT;

-- Authenticating a request looks a session up by its token hash. Making it
-- unique also means two sessions can never collide on one, which would make
-- one token authenticate the wrong user.
CREATE UNIQUE INDEX sessions_by_token ON sessions (token_hash);

-- Listing or revoking every session a user or a device holds — what happens
-- when someone is suspended or a device is lost.
CREATE INDEX sessions_by_user ON sessions (business_id, user_id);
CREATE INDEX sessions_by_device ON sessions (business_id, device_id);

-- +goose Down

DROP TABLE sessions;
DROP TABLE devices;
