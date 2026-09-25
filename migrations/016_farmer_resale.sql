-- Farmers selling their leftover organic fertilizer to other farmers, through the village center.
--
--  * farmer_wallet_entry: a plain ledger (credits and debits) of platform wallet money. A farmer's
--    balance is the sum of it. Resale earnings, dispute refunds and order payments all go through it.
--  * resale_listing: what a farmer offers, from "draft" to "listed" (inspected and in the center) or
--    rejected. Digital listings can go live before the goods reach the center; a buyer's order then
--    starts a 48-hour clock for the seller to bring them.
--  * surplus_lot gains resale_id and physical_received: a lot for a listing that is live but not yet
--    handed over cannot be collected by the buyer until the operator has inspected it.
--  * resale_sale: one row per collected order, with the commission split and how the seller is paid.
--  * resale_dispute: a buyer's complaint within 48 hours of pickup, settled by an admin.

CREATE TABLE farmer_wallet_entry (
  entry_id    text PRIMARY KEY,
  owner_id    text NOT NULL,
  amount      numeric(12,2) NOT NULL CHECK (amount <> 0),
  kind        text NOT NULL CHECK (kind IN ('resale_earning','order_payment','order_refund','dispute_refund','dispute_debit','adjustment')),
  ref_id      text,
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX farmer_wallet_owner_idx ON farmer_wallet_entry (owner_id, created_at DESC);

ALTER TABLE payment ADD COLUMN method text NOT NULL DEFAULT 'razorpay' CHECK (method IN ('razorpay','wallet'));

ALTER TABLE surplus_lot DROP CONSTRAINT surplus_lot_condition_check;
ALTER TABLE surplus_lot ADD CONSTRAINT surplus_lot_condition_check
  CHECK (condition IN ('near_expiry','opened','returned','damaged_packaging','other','sealed','partially_used'));

CREATE TABLE resale_listing (
  id                 text PRIMARY KEY,
  seller_id          text,                       -- null for a walk-in seller with no account
  seller_name        text NOT NULL DEFAULT '',
  seller_phone       text NOT NULL DEFAULT '',
  center_id          text NOT NULL REFERENCES village_center(center_id) ON DELETE CASCADE,
  product_id         text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  channel            text NOT NULL CHECK (channel IN ('digital','walk_in')),
  units              integer NOT NULL CHECK (units > 0),
  condition          text NOT NULL CHECK (condition IN ('sealed','opened','partially_used')),
  mfg_date           date,
  expiry_date        date NOT NULL,
  batch_number       text NOT NULL DEFAULT '',
  asking_price       numeric(12,2) NOT NULL CHECK (asking_price > 0),
  suggested_price    numeric(12,2) NOT NULL CHECK (suggested_price > 0),
  final_price        numeric(12,2),
  payout_mode        text NOT NULL CHECK (payout_mode IN ('wallet','upi','cash')),
  upi_id             text NOT NULL DEFAULT '',
  purchase_order_id  text,
  verified_purchase  boolean NOT NULL DEFAULT false,
  status             text NOT NULL CHECK (status IN ('draft','pending_verification','inspection_required','live','awaiting_handover','listed','sold_out','rejected','withdrawn')),
  lot_id             text REFERENCES surplus_lot(id) ON DELETE SET NULL,
  inspection         jsonb,
  inspected_by       text,
  inspected_at       timestamptz,
  handover_due       timestamptz,
  reject_reason      text NOT NULL DEFAULT '',
  season             text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (seller_id IS NOT NULL OR (payout_mode = 'cash' AND seller_name <> ''))
);
CREATE INDEX resale_listing_seller_idx ON resale_listing (seller_id, created_at DESC);
CREATE INDEX resale_listing_center_idx ON resale_listing (center_id, status);
CREATE INDEX resale_listing_season_idx ON resale_listing (seller_id, product_id, season);

ALTER TABLE surplus_lot
  ADD COLUMN resale_id text REFERENCES resale_listing(id) ON DELETE SET NULL,
  ADD COLUMN physical_received boolean NOT NULL DEFAULT true;
CREATE INDEX surplus_lot_resale_idx ON surplus_lot (resale_id) WHERE resale_id IS NOT NULL;

CREATE TABLE resale_photo (
  listing_id    text NOT NULL REFERENCES resale_listing(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('front','back')),
  content_type  text NOT NULL,
  data          bytea NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, kind)
);

CREATE TABLE resale_sale (
  sale_id        text PRIMARY KEY,
  listing_id     text NOT NULL REFERENCES resale_listing(id) ON DELETE CASCADE,
  order_id       text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  center_id      text NOT NULL,
  seller_id      text,
  buyer_id       text,
  units          integer NOT NULL CHECK (units > 0),
  unit_price     numeric(12,2) NOT NULL,
  gross          numeric(12,2) NOT NULL,
  platform_fee   numeric(12,2) NOT NULL,
  operator_cut   numeric(12,2) NOT NULL,
  seller_net     numeric(12,2) NOT NULL,
  verified       boolean NOT NULL,
  payout_mode    text NOT NULL,
  payout_status  text NOT NULL CHECK (payout_status IN ('paid','pending','cash_due','cash_paid')),
  payout_ref     text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, order_id)
);
CREATE INDEX resale_sale_seller_idx ON resale_sale (seller_id, created_at DESC);
CREATE INDEX resale_sale_center_idx ON resale_sale (center_id, payout_status);

CREATE TABLE resale_dispute (
  dispute_id      text PRIMARY KEY,
  sale_id         text NOT NULL REFERENCES resale_sale(sale_id) ON DELETE CASCADE,
  order_id        text NOT NULL,
  buyer_id        text NOT NULL,
  reason          text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','rejected')),
  refund_percent  integer,
  refund_amount   numeric(12,2),
  resolution_note text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  UNIQUE (sale_id)
);

-- How well a center has inspected: each upheld dispute over a listing it approved lowers it.
ALTER TABLE village_center ADD COLUMN resale_quality integer NOT NULL DEFAULT 100 CHECK (resale_quality BETWEEN 0 AND 100);
