-- Multi-center model. Until now the server assumed a single village center:
-- one global inventory, one operator, orders with no center. This migration
-- introduces real centers, each with its own inventory, operator and orders.
--
-- Destructive on purpose (same as 002): the old global demo inventory, the
-- demo restock requests, the operator's demo "farmers" and the six demo orders
-- are removed. Real farmer orders are kept; they simply have no center yet.

-- Everyone who has signed in, recorded on first contact (GET /v1/me). Accounts
-- live in Supabase; this is only what the admin panel needs to list and manage
-- people. `requested_role` is what they chose at sign-up, NOT their authority:
-- an operator is whoever owns a village_center, an admin is whoever is listed
-- in the server's SUPER_ADMIN_EMAILS.
CREATE TABLE app_user (
  user_id         text PRIMARY KEY,
  email           text NOT NULL DEFAULT '',
  name            text NOT NULL DEFAULT '',
  requested_role  text NOT NULL DEFAULT 'farmer' CHECK (requested_role IN ('farmer','operator')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_user_role_idx ON app_user (requested_role, created_at DESC);

CREATE TABLE village_center (
  center_id      text PRIMARY KEY,
  name           text NOT NULL,
  village        text NOT NULL,
  district       text NOT NULL DEFAULT '',
  latitude       double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude      double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  -- The Supabase user who runs this center. One operator, one center.
  operator_id    text UNIQUE,
  operator_name  text NOT NULL DEFAULT '',
  phone          text NOT NULL DEFAULT '',
  -- The operator's own open/closed switch, on top of the daily hours below.
  is_open        boolean NOT NULL DEFAULT true,
  opens_at       time NOT NULL DEFAULT '09:00',
  closes_at      time NOT NULL DEFAULT '18:00',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX village_center_geo_idx ON village_center (latitude, longitude);

-- One row per product per center. available = on_hand - reserved; the
-- farmer-facing app must use `available`, never `on_hand`, because reserved
-- stock is already promised to someone else's pending order.
CREATE TABLE center_inventory (
  center_id          text NOT NULL REFERENCES village_center(center_id) ON DELETE CASCADE,
  product_id         text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  on_hand            integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved           integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  reorder_level      integer NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
  max_capacity       integer CHECK (max_capacity IS NULL OR max_capacity > 0),
  incoming           integer NOT NULL DEFAULT 0 CHECK (incoming >= 0),
  last_restocked_at  timestamptz,
  PRIMARY KEY (center_id, product_id),
  CHECK (reserved <= on_hand),
  CHECK (max_capacity IS NULL OR on_hand <= max_capacity)
);
CREATE INDEX center_inventory_product_idx ON center_inventory (product_id);

DELETE FROM orders WHERE id IN ('order-1','order-2','order-3','order-4','order-5','order-6');

DROP TABLE restock_requests;
DROP TABLE inventory_items;
DROP TABLE farmers;

CREATE TABLE restock_requests (
  id                  text PRIMARY KEY,
  center_id           text NOT NULL REFERENCES village_center(center_id) ON DELETE CASCADE,
  product_id          text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  requested_quantity  integer NOT NULL CHECK (requested_quantity > 0),
  status              text NOT NULL CHECK (status IN ('pending','approved','fulfilled')),
  requested_date      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX restock_requests_center_idx ON restock_requests (center_id, requested_date DESC);

-- The operator's farmer list, now per center.
CREATE TABLE farmers (
  id               text PRIMARY KEY,
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  center_id        text NOT NULL REFERENCES village_center(center_id) ON DELETE CASCADE,
  name             text NOT NULL,
  village          text NOT NULL,
  phone            text NOT NULL,
  active_crop      text NOT NULL,
  last_visit_date  timestamptz NOT NULL,
  needs_follow_up  boolean NOT NULL DEFAULT false,
  notes            text NOT NULL DEFAULT ''
);
CREATE INDEX farmers_center_idx ON farmers (center_id, seq);

-- NULL = not assigned to a center (orders from before centers existed).
ALTER TABLE orders ADD COLUMN center_id text REFERENCES village_center(center_id);
CREATE INDEX orders_center_idx ON orders (center_id, created_at DESC);
