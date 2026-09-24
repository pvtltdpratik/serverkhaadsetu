-- Farmers who can deliver for other farmers ("delivery partners").
--
-- A delivery partner is not a separate account: it is an ordinary farmer with
-- a delivery_partner row. The row walks through a review:
--   draft -> pending -> approved            (the village center's operator checks the papers)
--                    -> rejected -> draft   (fix and submit again)
--   approved -> suspended -> approved       (operator or admin)
-- Changing the vehicle or the papers of an approved partner sends them back to
-- pending, so what was approved is always what is on the road.

-- What a delivery weighs, so a job can be matched to a vehicle that can carry
-- it and the fee can depend on load. Filled from the unit label ("40 kg bag")
-- for what exists; new products get 1 kg until someone sets it.
ALTER TABLE products ADD COLUMN weight_kg numeric(8,2) NOT NULL DEFAULT 1 CHECK (weight_kg > 0);
UPDATE products SET weight_kg = CASE
  WHEN unit_label ~* '[0-9]+(\.[0-9]+)?\s*kg' THEN substring(unit_label from '([0-9]+(?:\.[0-9]+)?)\s*[kK][gG]')::numeric
  WHEN unit_label ~* '[0-9]+(\.[0-9]+)?\s*(l|litre|liter)s?\y' THEN substring(unit_label from '([0-9]+(?:\.[0-9]+)?)\s*[lL]')::numeric
  WHEN unit_label ~* 'per kg' THEN 1
  WHEN category = 'equipment' THEN 5
  ELSE weight_kg END;

CREATE TABLE delivery_partner (
  user_id          text PRIMARY KEY,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','approved','rejected','suspended')),
  vehicle_type     text CHECK (vehicle_type IN ('bike','pickup','tractor')),
  vehicle_number   text,
  capacity_kg      integer CHECK (capacity_kg > 0),
  phone            text,
  -- How far from his own spot he is willing to go, and when he is usually free.
  max_distance_km  integer NOT NULL DEFAULT 10 CHECK (max_distance_km BETWEEN 1 AND 50),
  days             smallint NOT NULL DEFAULT 127 CHECK (days BETWEEN 1 AND 127),   -- bit 0 = Monday ... bit 6 = Sunday
  free_from        time NOT NULL DEFAULT '06:00',
  free_until       time NOT NULL DEFAULT '20:00',
  CHECK (free_from < free_until),
  -- The "I am free right now" switch, on top of the schedule.
  online           boolean NOT NULL DEFAULT false,
  -- The center whose operator checks his papers.
  review_center_id text REFERENCES village_center(center_id) ON DELETE SET NULL,
  rejection_reason text,
  reviewed_by      text,
  reviewed_at      timestamptz,
  submitted_at     timestamptz,
  rating_avg       numeric(3,2) NOT NULL DEFAULT 0,
  rating_count     integer NOT NULL DEFAULT 0,
  deliveries_done  integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Nobody can wait for review, or be approved, with half a profile.
  CHECK (status NOT IN ('pending','approved','suspended')
         OR (vehicle_type IS NOT NULL AND vehicle_number IS NOT NULL AND capacity_kg IS NOT NULL AND phone IS NOT NULL))
);
-- One road vehicle, one active partner. A rejected or draft entry does not block it.
CREATE UNIQUE INDEX delivery_partner_vehicle_idx ON delivery_partner (vehicle_number)
  WHERE status IN ('pending','approved','suspended');
CREATE INDEX delivery_partner_center_idx ON delivery_partner (review_center_id, status);

-- The licence and the RC, stored privately: they are only ever served to the
-- owner, the reviewing operator and admins, never from a public URL.
CREATE TABLE delivery_document (
  user_id       text NOT NULL REFERENCES delivery_partner(user_id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('licence','rc')),
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  data          bytea NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

-- Who did what to a partner's application, and why.
CREATE TABLE delivery_partner_event (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES delivery_partner(user_id) ON DELETE CASCADE,
  actor_id    text,
  actor_role  text NOT NULL CHECK (actor_role IN ('partner','operator','admin','system')),
  action      text NOT NULL,
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_partner_event_user_idx ON delivery_partner_event (user_id, created_at DESC);
