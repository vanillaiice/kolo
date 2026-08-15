-- +goose Up
-- Products sync last-write-wins, and last-write-wins needs a total order
-- (ADR-015). The timestamp alone is not one: two devices can stamp the same
-- millisecond, and breaking that tie by arrival order would let two devices
-- converge on different prices, permanently and silently.
--
-- The device that made the edit breaks the tie. It is arbitrary but
-- deterministic, which is the property that matters: applying the same set of
-- edits in any order gives the same answer everywhere.
--
-- Nullable, because rows written before this decision have no device recorded.
-- A null sorts below any device, so an edit from a real device always beats one
-- from before the column existed — which is the right way round, those rows
-- being older.
ALTER TABLE products ADD COLUMN updated_by_device UUID REFERENCES devices (id) ON DELETE RESTRICT;

-- +goose Down
ALTER TABLE products DROP COLUMN updated_by_device;
