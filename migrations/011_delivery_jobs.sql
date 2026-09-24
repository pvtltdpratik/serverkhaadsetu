-- Home delivery: a farmer who ordered can have it brought by a delivery partner
-- (a farmer with a vehicle, see 010) instead of collecting it at the center.
--
-- One order can have one delivery job. The job goes:
--   open        looking for a partner: offers go to the nearest ones that fit
--   assigned    a partner accepted (or the operator picked one) and is heading to the center
--   in_transit  the operator handed over the goods after the partner's code
--   delivered   the buyer gave the partner the second code
--   cancelled   called off (buyer switched to pickup, order cancelled, ...)
--   fallback    nobody took it in time: the order simply waits for pickup at the center
--
-- The two codes are the proof: pickup_otp is shown ONLY to the partner and read
-- to the operator at the counter; drop_otp is shown ONLY to the buyer and read
-- to the partner at the farm.

ALTER TABLE delivery_partner
  ADD COLUMN latitude       double precision CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN longitude      double precision CHECK (longitude BETWEEN -180 AND 180),
  ADD COLUMN located_at     timestamptz,
  -- Jobs he dropped after accepting; a reliability signal.
  ADD COLUMN cancellations  integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT delivery_partner_location_pair CHECK ((latitude IS NULL) = (longitude IS NULL));

ALTER TABLE orders
  ADD COLUMN fulfilment    text NOT NULL DEFAULT 'pickup' CHECK (fulfilment IN ('pickup','delivery')),
  ADD COLUMN delivery_fee  numeric(10,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0);

CREATE TABLE delivery_job (
  id                  text PRIMARY KEY,
  -- 'center_order' carries an order from a center to its buyer. 'p2p' (see later
  -- phases) carries something from one farmer to another.
  kind                text NOT NULL DEFAULT 'center_order' CHECK (kind IN ('center_order','p2p')),
  order_id            text UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  center_id           text REFERENCES village_center(center_id) ON DELETE SET NULL,
  requester_id        text NOT NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','in_transit','delivered','cancelled','fallback')),
  partner_id          text REFERENCES delivery_partner(user_id) ON DELETE SET NULL,
  weight_kg           numeric(8,2) NOT NULL CHECK (weight_kg > 0),
  distance_km         numeric(6,2) NOT NULL CHECK (distance_km >= 0),   -- by road, pickup to drop
  fee                 numeric(10,2) NOT NULL CHECK (fee >= 0),
  -- What the goods cost. The partner collects goods + fee in cash at the drop and
  -- owes the goods amount back to the center (see delivery_ledger).
  goods_amount        numeric(12,2) NOT NULL DEFAULT 0 CHECK (goods_amount >= 0),
  pickup_latitude     double precision NOT NULL,
  pickup_longitude    double precision NOT NULL,
  pickup_label        text NOT NULL DEFAULT '',
  drop_latitude       double precision NOT NULL,
  drop_longitude      double precision NOT NULL,
  drop_label          text NOT NULL DEFAULT '',
  drop_village        text NOT NULL DEFAULT '',
  drop_phone          text NOT NULL,
  drop_note           text NOT NULL DEFAULT '',
  pickup_otp          text NOT NULL,
  drop_otp            text NOT NULL,
  -- Wrong codes are counted; five wrong in a row locks that step for 15 minutes.
  pickup_failed       smallint NOT NULL DEFAULT 0,
  pickup_locked_until timestamptz,
  drop_failed         smallint NOT NULL DEFAULT 0,
  drop_locked_until   timestamptz,
  rounds              smallint NOT NULL DEFAULT 0,      -- how many batches of offers have gone out
  search_until        timestamptz NOT NULL,             -- give up (fallback) after this
  operator_told_at    timestamptz,                      -- nobody could be found: the operator was asked to help
  partner_latitude    double precision,
  partner_longitude   double precision,
  partner_located_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  assigned_at         timestamptz,
  picked_up_at        timestamptz,
  delivered_at        timestamptz,
  cancelled_at        timestamptz,
  cancelled_reason    text NOT NULL DEFAULT '',
  CHECK (status NOT IN ('assigned','in_transit','delivered') OR partner_id IS NOT NULL)
);
CREATE INDEX delivery_job_status_idx ON delivery_job (status, created_at);
CREATE INDEX delivery_job_center_idx ON delivery_job (center_id, status);
CREATE INDEX delivery_job_partner_idx ON delivery_job (partner_id, status);
CREATE INDEX delivery_job_requester_idx ON delivery_job (requester_id, created_at DESC);

-- A job offered to a partner. Offers go out in small rounds to the nearest fitting
-- partners; whoever accepts first gets it and the rest are closed.
CREATE TABLE delivery_offer (
  job_id       text NOT NULL REFERENCES delivery_job(id) ON DELETE CASCADE,
  partner_id   text NOT NULL,
  round        smallint NOT NULL,
  -- closed: another partner took the job, so this offer ended through no fault of his
  -- (unlike expired, which means he did not answer). A closed offer can be made again.
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired','released','closed')),
  offered_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  responded_at timestamptz,
  PRIMARY KEY (job_id, partner_id)
);
CREATE INDEX delivery_offer_partner_idx ON delivery_offer (partner_id, status);

-- The partner's money, as a ledger. There is no payment system: the buyer pays
-- goods + fee in cash to the partner at the drop. So a delivery does two things:
-- it EARNS the partner the fee (which he keeps out of that cash), and it makes
-- him OWE the center the goods amount, until the operator marks it handed over.
CREATE TABLE delivery_ledger (
  id          text PRIMARY KEY,
  partner_id  text NOT NULL,
  job_id      text,
  center_id   text,
  kind        text NOT NULL CHECK (kind IN ('fee_earned','goods_owed','goods_settled')),
  amount      numeric(12,2) NOT NULL,      -- goods_settled is negative; the others are positive
  note        text NOT NULL DEFAULT '',
  actor_id    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_ledger_partner_idx ON delivery_ledger (partner_id, created_at DESC);
CREATE INDEX delivery_ledger_center_idx ON delivery_ledger (center_id, partner_id);

-- Each side rates the other once per delivery.
CREATE TABLE delivery_rating (
  job_id      text NOT NULL REFERENCES delivery_job(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('buyer_to_partner','partner_to_buyer')),
  rater_id    text NOT NULL,
  ratee_id    text NOT NULL,
  stars       smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, role)
);
