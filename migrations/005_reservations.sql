-- Stock reservations for app orders.
--
-- An app order HOLDS stock at its center from the moment it is placed:
-- center_inventory.reserved goes up, so `available` (on_hand - reserved) drops
-- and nobody else -- a walk-in customer or another farmer's order -- can be
-- promised it. The hold ends one of three ways: the farmer collects the order
-- (on_hand and reserved both drop), the order is cancelled, or the reservation
-- expires. `stock_reserved` records whether an order currently holds stock, so
-- releasing or consuming can never happen twice.

-- Which product a line is for (needed to know what to release). NULL on lines
-- from before this migration, which never held stock.
ALTER TABLE order_items ADD COLUMN product_id text REFERENCES products(id) ON DELETE SET NULL;

ALTER TABLE orders
  ADD COLUMN stock_reserved    boolean NOT NULL DEFAULT false,
  ADD COLUMN reserved_until    timestamptz,
  -- 0 = none sent, 1 = "day 3" reminder sent, 2 = "day 5" reminder sent
  ADD COLUMN reminder_stage    smallint NOT NULL DEFAULT 0 CHECK (reminder_stage BETWEEN 0 AND 2),
  -- Where the farmer was when ordering, so an order can be re-assigned to the
  -- next-best center later if its center goes offline.
  ADD COLUMN origin_latitude   double precision,
  ADD COLUMN origin_longitude  double precision;

-- The maintenance job scans only orders that currently hold stock.
CREATE INDEX orders_reservation_idx ON orders (reserved_until) WHERE stock_reserved;
