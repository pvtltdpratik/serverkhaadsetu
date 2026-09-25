-- Structured fertilizer reviews: an agronomic outcome log in three phases, not a star rating.
--
--   phase 1 (before applying): the baseline. Farm, soil, crop, dose, method; NPK and soil score from the latest scan.
--   phase 2 (4 to 6 weeks on):  optional crop observations.
--   phase 3 (after harvest):    the yield and how the farmer felt about it.
--
-- A review needs a collected order for the product and the farmer's own farm profile. Unusual results are held
-- ("flagged") until an agronomist looks at them. Completed reviews are also training data for the recommendation
-- and yield models (phase 1 inputs with phase 3 outcomes).
CREATE TABLE fertilizer_review (
  review_id           text PRIMARY KEY,
  owner_id            text NOT NULL,
  product_id          text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  order_id            text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  season              text NOT NULL,
  -- phase 1
  acres               numeric(7,2) NOT NULL CHECK (acres > 0),
  soil_type           text NOT NULL,
  crop                text NOT NULL,
  variety             text NOT NULL DEFAULT '',
  growth_stage        text NOT NULL,
  irrigation          text NOT NULL,
  qty_per_acre        numeric(8,2) NOT NULL CHECK (qty_per_acre > 0),
  unit_label          text NOT NULL DEFAULT '',
  method              text NOT NULL,
  reason              text NOT NULL,
  district            text NOT NULL DEFAULT '',
  size_class          text NOT NULL CHECK (size_class IN ('small','medium','large')),
  npk_before          jsonb,
  score_before        integer,
  applied_on          date NOT NULL,
  phase1_at           timestamptz NOT NULL DEFAULT now(),
  -- phase 2
  mid                 jsonb,
  phase2_at           timestamptz,
  -- phase 3
  yield_qpa           numeric(8,2),
  last_season_qpa     numeric(8,2),
  district_avg_qpa    numeric(8,2),
  baseline_qpa        numeric(8,2),
  improvement_pct     numeric(8,2),
  score_after         integer,
  npk_after           jsonb,
  stars_overall       integer CHECK (stars_overall BETWEEN 1 AND 5),
  stars_value         integer CHECK (stars_value BETWEEN 1 AND 5),
  stars_ease          integer CHECK (stars_ease BETWEEN 1 AND 5),
  use_again           text CHECK (use_again IN ('yes','no','maybe')),
  recommend           boolean,
  comment             text NOT NULL DEFAULT '',
  phase3_at           timestamptz,
  status              text NOT NULL DEFAULT 'phase1' CHECK (status IN ('phase1','phase2','flagged','published','hidden')),
  flag_reason         text NOT NULL DEFAULT '',
  agronomist_reviewed boolean NOT NULL DEFAULT false,
  agronomist_note     text NOT NULL DEFAULT '',
  featured            boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, product_id, season, crop)
);
CREATE INDEX fertilizer_review_product_idx ON fertilizer_review (product_id, status);
CREATE INDEX fertilizer_review_owner_idx ON fertilizer_review (owner_id, created_at DESC);

CREATE TABLE review_photo (
  review_id     text NOT NULL REFERENCES fertilizer_review(review_id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('mid','harvest')),
  content_type  text NOT NULL,
  data          bytea NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, kind)
);

-- What a farmer earns for logging: coins, badges, and a period of priority access.
CREATE TABLE farmer_reward (
  reward_id   text PRIMARY KEY,
  owner_id    text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('coins','badge','priority')),
  amount      integer NOT NULL DEFAULT 0,
  badge       text NOT NULL DEFAULT '',
  ref_id      text,
  note        text NOT NULL DEFAULT '',
  until       timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX farmer_reward_owner_idx ON farmer_reward (owner_id, created_at DESC);
-- A badge is earned once.
CREATE UNIQUE INDEX farmer_reward_one_badge ON farmer_reward (owner_id, badge) WHERE kind = 'badge';

-- A percentage off the goods of one later order.
CREATE TABLE farmer_coupon (
  code           text PRIMARY KEY,
  owner_id       text NOT NULL,
  percent        numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 50),
  source         text NOT NULL,
  used_order_id  text,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX farmer_coupon_owner_idx ON farmer_coupon (owner_id, created_at DESC);

ALTER TABLE orders
  ADD COLUMN discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  ADD COLUMN coupon_code text;

ALTER TABLE farmer_wallet_entry DROP CONSTRAINT farmer_wallet_entry_kind_check;
ALTER TABLE farmer_wallet_entry ADD CONSTRAINT farmer_wallet_entry_kind_check
  CHECK (kind IN ('resale_earning','order_payment','order_refund','dispute_refund','dispute_debit','adjustment','coin_redemption'));
