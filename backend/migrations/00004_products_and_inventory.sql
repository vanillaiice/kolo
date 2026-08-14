-- Products and the stock ledger.
--
-- The ledger is append-only, and this migration enforces that in the database
-- rather than trusting every future caller to remember (§7, §59; ADR-009).
-- Stock is derived by summing it; no table here holds a stock level.

-- +goose Up

CREATE TABLE categories (
    id          uuid        PRIMARY KEY,
    business_id uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    name        text        NOT NULL,
    active      boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL,

    CONSTRAINT categories_name_not_blank
        CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    CONSTRAINT categories_updated_after_created
        CHECK (updated_at >= created_at)
);

ALTER TABLE categories
    ADD CONSTRAINT categories_business_scoped_identity UNIQUE (id, business_id);

CREATE INDEX categories_by_business ON categories (business_id, name);

CREATE TABLE products (
    id                    uuid        PRIMARY KEY,
    business_id           uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    category_id           uuid        REFERENCES categories (id) ON DELETE RESTRICT,

    name                  text        NOT NULL,
    -- Both optional: a shopkeeper entering stock at the till has neither yet.
    sku                   text,
    barcode               text,
    description           text,
    brand                 text,

    unit                  text        NOT NULL,
    -- Whether a fraction of a unit is meaningful. Rice by the kilo is; a
    -- bottle is not.
    divisible             boolean     NOT NULL DEFAULT false,

    -- Null when the business does not yet know what it paid — stock inherited
    -- from before the system, or a delivery whose invoice has not arrived.
    -- A guess would be worse than an honest gap (§8).
    purchase_price_minor  bigint,
    selling_price_minor   bigint      NOT NULL,
    currency              char(3)     NOT NULL,

    -- Hundredths of a percent, so 19.25% is 1925. An integer because §44
    -- forbids floating point for anything feeding a money calculation.
    tax_rate_basis_points integer     NOT NULL DEFAULT 0,

    -- Thousandths of a unit, matching the domain's exact quantity type.
    minimum_stock         bigint      NOT NULL DEFAULT 0,

    active                boolean     NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL,
    updated_at            timestamptz NOT NULL,

    CONSTRAINT products_name_not_blank
        CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    CONSTRAINT products_unit_not_blank
        CHECK (char_length(btrim(unit)) BETWEEN 1 AND 24),
    -- A code with a space in it would not match when scanned again.
    CONSTRAINT products_sku_usable
        CHECK (sku IS NULL OR (sku = btrim(sku) AND sku !~ '\s' AND char_length(sku) BETWEEN 1 AND 48)),
    CONSTRAINT products_barcode_usable
        CHECK (barcode IS NULL OR (barcode = btrim(barcode) AND barcode !~ '\s' AND char_length(barcode) BETWEEN 1 AND 48)),
    CONSTRAINT products_prices_not_negative
        CHECK (selling_price_minor >= 0 AND (purchase_price_minor IS NULL OR purchase_price_minor >= 0)),
    CONSTRAINT products_currency_uppercase
        CHECK (currency = upper(currency)),
    CONSTRAINT products_tax_rate_in_range
        CHECK (tax_rate_basis_points BETWEEN 0 AND 10000),
    CONSTRAINT products_minimum_stock_not_negative
        CHECK (minimum_stock >= 0),
    -- A product sold whole cannot have a reorder point of half a unit.
    CONSTRAINT products_minimum_stock_divisible
        CHECK (divisible OR minimum_stock % 1000 = 0),
    CONSTRAINT products_updated_after_created
        CHECK (updated_at >= created_at)
);

ALTER TABLE products
    ADD CONSTRAINT products_business_scoped_identity UNIQUE (id, business_id);

-- A product must be filed under a category of its own business, for the same
-- reason a user must belong to a branch of theirs: plain foreign keys allow the
-- mismatch because each identifier is individually valid.
ALTER TABLE products
    ADD CONSTRAINT products_category_within_same_business
    FOREIGN KEY (category_id, business_id)
    REFERENCES categories (id, business_id) ON DELETE RESTRICT;

-- Codes identify a product within one business, not globally. Two shops may
-- each sell the same manufacturer's barcode, and a global constraint would make
-- one of them unable to record it.
CREATE UNIQUE INDEX products_sku_per_business ON products (business_id, sku) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX products_barcode_per_business ON products (business_id, barcode) WHERE barcode IS NOT NULL;

-- Product search must be fast on cheap hardware (§46). This covers the listing
-- and the name lookup; a barcode scan uses the unique index above.
CREATE INDEX products_by_business ON products (business_id, name);
CREATE INDEX products_by_category ON products (business_id, category_id) WHERE category_id IS NOT NULL;

CREATE TABLE inventory_movements (
    id                  uuid        PRIMARY KEY,
    business_id         uuid        NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
    branch_id           uuid        REFERENCES branches (id) ON DELETE RESTRICT,
    product_id          uuid        NOT NULL REFERENCES products (id) ON DELETE RESTRICT,

    type                text        NOT NULL,
    -- Signed thousandths: positive adds stock, negative removes it. Summing the
    -- ledger is then plain addition with no per-type special cases.
    quantity            bigint      NOT NULL,

    -- What one unit cost on the way in, kept so stock can be valued at what was
    -- paid rather than at what it sells for (§8). Null where cost means
    -- nothing, as on a sale.
    unit_cost_minor     bigint,
    unit_cost_currency  char(3),

    -- What caused the movement. §40 requires movements to be traceable.
    reference_kind      text,
    reference_id        text,
    reason              text,

    user_id             uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    device_id           uuid        NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,

    -- When the stock actually moved, which for a device offline for days is
    -- days ago. Reports slice on this.
    occurred_at         timestamptz NOT NULL,
    -- When this row was written. Sync and troubleshooting need it, and it is
    -- deliberately not the same column.
    recorded_at         timestamptz NOT NULL,

    CONSTRAINT inventory_movements_type_known
        CHECK (type IN ('PURCHASE', 'SALE', 'SALE_RETURN', 'PURCHASE_RETURN', 'DAMAGE',
                        'ADJUSTMENT', 'STOCK_COUNT', 'TRANSFER_OUT', 'TRANSFER_IN',
                        'OPENING_BALANCE')),

    -- A movement of nothing says nothing.
    CONSTRAINT inventory_movements_quantity_not_zero
        CHECK (quantity <> 0),

    -- A sign that contradicts the type is a mistake caught here rather than as
    -- an inexplicable stock level weeks later. Corrections go either way,
    -- because a count can find more or less than the ledger says.
    CONSTRAINT inventory_movements_direction
        CHECK (
            (type IN ('PURCHASE', 'SALE_RETURN', 'TRANSFER_IN', 'OPENING_BALANCE') AND quantity > 0)
            OR (type IN ('SALE', 'PURCHASE_RETURN', 'DAMAGE', 'TRANSFER_OUT') AND quantity < 0)
            OR type IN ('ADJUSTMENT', 'STOCK_COUNT')
        ),

    -- Corrections and write-offs are where stock changes with no sale or
    -- delivery to explain it, which is exactly where an owner needs to know why.
    CONSTRAINT inventory_movements_reason_when_required
        CHECK (type NOT IN ('ADJUSTMENT', 'STOCK_COUNT', 'DAMAGE')
               OR char_length(btrim(coalesce(reason, ''))) > 0),

    CONSTRAINT inventory_movements_reference_when_required
        CHECK (type NOT IN ('PURCHASE', 'SALE', 'SALE_RETURN', 'PURCHASE_RETURN',
                            'TRANSFER_IN', 'TRANSFER_OUT')
               OR (reference_kind IS NOT NULL AND reference_id IS NOT NULL)),

    CONSTRAINT inventory_movements_reference_complete
        CHECK ((reference_kind IS NULL) = (reference_id IS NULL)),

    CONSTRAINT inventory_movements_cost_complete
        CHECK ((unit_cost_minor IS NULL) = (unit_cost_currency IS NULL)),
    CONSTRAINT inventory_movements_cost_not_negative
        CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0)
);

-- The product, branch, user, and device must all belong to the movement's
-- business, or a movement could span two tenants.
ALTER TABLE inventory_movements
    ADD CONSTRAINT inventory_movements_product_within_same_business
    FOREIGN KEY (product_id, business_id)
    REFERENCES products (id, business_id) ON DELETE RESTRICT;

ALTER TABLE inventory_movements
    ADD CONSTRAINT inventory_movements_branch_within_same_business
    FOREIGN KEY (branch_id, business_id)
    REFERENCES branches (id, business_id) ON DELETE RESTRICT;

ALTER TABLE inventory_movements
    ADD CONSTRAINT inventory_movements_user_within_same_business
    FOREIGN KEY (user_id, business_id)
    REFERENCES users (id, business_id) ON DELETE RESTRICT;

ALTER TABLE inventory_movements
    ADD CONSTRAINT inventory_movements_device_within_same_business
    FOREIGN KEY (device_id, business_id)
    REFERENCES devices (id, business_id) ON DELETE RESTRICT;

-- Deriving stock is the query this table exists to serve: sum the quantities
-- for one product, optionally up to a moment. This index covers it.
CREATE INDEX inventory_movements_for_stock
    ON inventory_movements (business_id, product_id, occurred_at);

-- Listing a product's history, and the branch-scoped variants of the above.
CREATE INDEX inventory_movements_by_branch
    ON inventory_movements (business_id, branch_id, occurred_at) WHERE branch_id IS NOT NULL;

-- The ledger is append-only. ADR-009 says so and the domain refuses to edit a
-- movement, but the domain is not the only thing that can reach this table: a
-- migration, a support script, or a future service could. Enforcing it here
-- means a correction has to be what the specification requires — another
-- movement — rather than a quiet edit that leaves no trace (§40, §41).

-- +goose StatementBegin
CREATE FUNCTION inventory_movements_are_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'inventory_movements is append-only: record a correcting movement instead of %ing this one',
        lower(TG_OP)
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER inventory_movements_no_update
    BEFORE UPDATE ON inventory_movements
    FOR EACH ROW EXECUTE FUNCTION inventory_movements_are_append_only();

CREATE TRIGGER inventory_movements_no_delete
    BEFORE DELETE ON inventory_movements
    FOR EACH ROW EXECUTE FUNCTION inventory_movements_are_append_only();

-- +goose Down

DROP TRIGGER inventory_movements_no_delete ON inventory_movements;
DROP TRIGGER inventory_movements_no_update ON inventory_movements;
DROP FUNCTION inventory_movements_are_append_only();
DROP TABLE inventory_movements;
DROP TABLE products;
DROP TABLE categories;
