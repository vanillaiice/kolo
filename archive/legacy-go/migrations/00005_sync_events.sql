-- The server's record of every event it has been sent.
--
-- This table is what makes the server idempotent (§27, ADR-006). An event
-- carries a globally unique identifier, and the primary key here is that
-- identifier: a replay after an unacknowledged push collides and is recognised
-- rather than applied a second time.
--
-- Events are kept after they are applied. They are the record of what each
-- device actually said, which is what a pull replays to other devices and what
-- anyone diagnosing a disagreement between two tills has to read.

-- +goose Up

CREATE TABLE sync_events (
    -- Generated on the device, offline, before the server ever sees it
    -- (ADR-011). The primary key is the idempotency guarantee.
    event_id        uuid        PRIMARY KEY,

    business_id     uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    device_id       uuid        NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

    type            text        NOT NULL CHECK (char_length(btrim(type)) > 0),
    payload         jsonb       NOT NULL,

    -- When the business event happened, as the device reported it. A device
    -- offline for days sends events days old, and those timestamps are the true
    -- ones (§45).
    occurred_at     timestamptz NOT NULL,
    -- The device's own ordering. Meaningful within one device and nowhere else:
    -- two devices' sequences say nothing about each other, which is what
    -- conflict policy exists for rather than ordering.
    device_sequence bigint      NOT NULL CHECK (device_sequence > 0),

    -- The server's ordering, and the cursor a pull resumes from. Assigned on
    -- arrival, so it reflects the order the server learned things rather than
    -- the order they happened — which is exactly what a client catching up
    -- needs, since it wants everything new to *it*.
    server_sequence bigserial   NOT NULL UNIQUE,
    received_at     timestamptz NOT NULL DEFAULT now(),

    -- Whether the server could make sense of it. A rejected event is kept
    -- rather than dropped: the device still holds the business record it
    -- describes, and someone has to be able to see why it did not land.
    status          text        NOT NULL DEFAULT 'applied'
                                CHECK (status IN ('applied', 'rejected')),
    rejection_reason text,

    CONSTRAINT sync_events_rejection_explained
        CHECK (status <> 'rejected' OR char_length(btrim(coalesce(rejection_reason, ''))) > 0)
);

-- The device and user must belong to the event's business, or one tenant could
-- push events attributed to another's staff.
ALTER TABLE sync_events
    ADD CONSTRAINT sync_events_device_within_same_business
    FOREIGN KEY (device_id, business_id)
    REFERENCES devices (id, business_id) ON DELETE RESTRICT;

ALTER TABLE sync_events
    ADD CONSTRAINT sync_events_user_within_same_business
    FOREIGN KEY (user_id, business_id)
    REFERENCES users (id, business_id) ON DELETE RESTRICT;

-- The pull query: everything this business has seen since the caller's cursor.
-- server_sequence is global rather than per-business, so a given business's
-- cursor has gaps — harmless, because the cursor is only ever compared against
-- itself.
CREATE INDEX sync_events_for_pull ON sync_events (business_id, server_sequence);

-- Diagnosing one device's history, and finding what a device has already sent.
CREATE INDEX sync_events_by_device ON sync_events (business_id, device_id, device_sequence);

-- Rejected events are what an operator needs to look at.
CREATE INDEX sync_events_rejected
    ON sync_events (business_id, received_at) WHERE status = 'rejected';

-- +goose Down

DROP TABLE sync_events;
