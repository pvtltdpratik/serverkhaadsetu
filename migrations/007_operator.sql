-- Operator tooling.

-- Low-stock alerting: when a product's AVAILABLE stock (on hand minus reserved)
-- first falls to its reorder level, the operator is alerted once and this is
-- stamped. It is cleared when stock recovers above the level, so the next dip
-- alerts again. A stamp older than 24 hours on a product that is still low
-- means the operator has not acted, which the admin overview surfaces.
ALTER TABLE center_inventory ADD COLUMN low_stock_alerted_at timestamptz;

-- The operator says a delivery did not match what was expected. The received
-- quantity is still added to the shelf (that is what physically arrived); the
-- platform's supply team reviews the difference.
CREATE TABLE stock_discrepancy (
  id                  text PRIMARY KEY,
  center_id           text NOT NULL REFERENCES village_center(center_id) ON DELETE CASCADE,
  product_id          text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  expected_quantity   integer NOT NULL CHECK (expected_quantity >= 0),
  received_quantity   integer NOT NULL CHECK (received_quantity >= 0),
  note                text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution_note     text NOT NULL DEFAULT '',
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  CHECK (expected_quantity <> received_quantity)
);
CREATE INDEX stock_discrepancy_status_idx ON stock_discrepancy (status, created_at DESC);

-- The operator's farmer list is now built from real orders at the center, so
-- the hand-entered table (empty since 003, and nothing ever filled it) goes.
DROP TABLE farmers;
