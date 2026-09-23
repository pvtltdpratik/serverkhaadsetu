-- Surplus / second-hand stock: units a center sells at a lower price than the
-- catalog, kept apart from the regular shelf (center_inventory).
--
-- A lot is a batch of units at one center with its own price, condition and
-- optional best-before date. It has the same on-hand / reserved shape as the
-- shelf so an app order can hold units from it with the same guarded UPDATE
-- (reserved + qty <= quantity), but it never feeds reorder levels, low-stock
-- alerts or center ranking: those describe the regular shelf only.
--
-- `from_shelf` records where the units came from. Marked down from the shelf,
-- they were deducted from center_inventory when the lot was made, and go back
-- if the lot is withdrawn. Otherwise they arrived from outside the supply
-- chain (a farmer's leftover, a transfer) and simply stop existing.

CREATE TABLE surplus_lot (
  id          text PRIMARY KEY,
  center_id   text NOT NULL REFERENCES village_center(center_id) ON DELETE CASCADE,
  product_id  text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity    integer NOT NULL CHECK (quantity >= 0),
  reserved    integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  unit_price  numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  condition   text NOT NULL CHECK (condition IN ('near_expiry','opened','returned','damaged_packaging','other')),
  best_before date,
  note        text NOT NULL DEFAULT '',
  from_shelf  boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved <= quantity)
);
CREATE INDEX surplus_lot_center_idx ON surplus_lot (center_id, status);
CREATE INDEX surplus_lot_product_idx ON surplus_lot (product_id) WHERE status = 'active';

-- Which lot an order line holds units from (NULL for regular shelf lines).
ALTER TABLE order_items ADD COLUMN surplus_lot_id text REFERENCES surplus_lot(id) ON DELETE SET NULL;
