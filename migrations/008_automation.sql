-- Automation for centers that stop responding, and back-in-stock alerts.

-- The last time this center's operator used the operator API. Updated on every
-- request (at most once a minute). A center silent for 12 hours *during its
-- opening hours* is treated as offline, and its unconfirmed orders are moved.
ALTER TABLE village_center ADD COLUMN last_active_at timestamptz NOT NULL DEFAULT now();

-- An order that was moved to another center (at most twice, so it can never
-- bounce around forever).
ALTER TABLE orders
  ADD COLUMN reassign_count  smallint NOT NULL DEFAULT 0,
  ADD COLUMN reassigned_at   timestamptz;

-- "Notify me when available": a farmer asks to be told when a product they
-- could not get comes back within reach. The place they asked from is kept, so
-- when ANY center within range receives the product they can be told. One-shot:
-- the row is removed when the notification is sent.
CREATE TABLE stock_subscription (
  owner_id    text NOT NULL,
  product_id  text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  latitude    double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude   double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, product_id)
);
CREATE INDEX stock_subscription_product_idx ON stock_subscription (product_id);
