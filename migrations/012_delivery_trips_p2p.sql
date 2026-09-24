-- Home delivery, phase 3: trips, batching, and farmer-to-farmer carriage.
--
-- * Trips: a delivery partner who is going somewhere on a day, with room to spare,
--   says so. Farmers can book that space; a delivery order along the same road can
--   also be offered to him first.
-- * Farmer-to-farmer ('p2p') jobs: someone wants a load carried from their place to
--   another farm (a resale, a borrowed tool, a sack of seed). There is no center and
--   no order: the sender hands the load over against the partner's code, and the
--   receiver gives the drop code on arrival. The partner is paid the fee in cash by
--   whoever pays it (fee_payer).
-- * Batching needs no table: one partner may carry several jobs (config
--   DELIVERY_MAX_ACTIVE_JOBS) as long as the loads fit his vehicle together.

CREATE TABLE delivery_trip (
  id              text PRIMARY KEY,
  partner_id      text NOT NULL REFERENCES delivery_partner(user_id) ON DELETE CASCADE,
  from_latitude   double precision NOT NULL CHECK (from_latitude BETWEEN -90 AND 90),
  from_longitude  double precision NOT NULL CHECK (from_longitude BETWEEN -180 AND 180),
  from_label      text NOT NULL DEFAULT '',
  to_latitude     double precision NOT NULL CHECK (to_latitude BETWEEN -90 AND 90),
  to_longitude    double precision NOT NULL CHECK (to_longitude BETWEEN -180 AND 180),
  to_label        text NOT NULL DEFAULT '',
  on_date         date NOT NULL,                      -- the day of the trip, on the center clock
  spare_kg        integer NOT NULL CHECK (spare_kg > 0),
  note            text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_trip_board_idx ON delivery_trip (status, on_date);
CREATE INDEX delivery_trip_partner_idx ON delivery_trip (partner_id, on_date);

ALTER TABLE delivery_job
  -- What is being carried (for p2p; a center order lists its own items).
  ADD COLUMN description  text NOT NULL DEFAULT '',
  -- Where the partner collects a p2p load, and who to call there.
  ADD COLUMN pickup_phone text NOT NULL DEFAULT '',
  -- Who hands the delivery fee to the partner in cash: at the pickup ('sender') or at the drop ('receiver').
  ADD COLUMN fee_payer    text NOT NULL DEFAULT 'receiver' CHECK (fee_payer IN ('sender','receiver')),
  -- Booked onto a partner's trip: the offer goes to him first and waits for him.
  ADD COLUMN trip_id      text REFERENCES delivery_trip(id) ON DELETE SET NULL,
  ADD CONSTRAINT delivery_job_kind_shape CHECK (
    (kind = 'center_order' AND order_id IS NOT NULL) OR (kind = 'p2p' AND order_id IS NULL AND center_id IS NULL)
  );
CREATE INDEX delivery_job_trip_idx ON delivery_job (trip_id) WHERE trip_id IS NOT NULL;
