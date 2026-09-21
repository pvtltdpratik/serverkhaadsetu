-- KHAAD Setu initial schema. Ids stay text (seed ids like 'p-neemcake',
-- generated ids like 'order-<uuid>') so API responses are unchanged.
-- `owner_id` is the Supabase user id (or the anonymous device id when
-- authentication is off) — deliberately not a foreign key: accounts live in
-- Supabase, not in this database.

CREATE TABLE products (
  id                  text PRIMARY KEY,
  seq  bigint GENERATED ALWAYS AS IDENTITY,  -- display order: catalog order is curated, not alphabetical
  name                text NOT NULL,
  brand               text NOT NULL,
  category            text NOT NULL CHECK (category IN ('fertilizer','organic','pesticide','seed','equipment')),
  price_in_rupees     numeric(12,2) NOT NULL CHECK (price_in_rupees >= 0),
  unit_label          text NOT NULL,
  rating              numeric(2,1) NOT NULL DEFAULT 0,
  review_count        integer NOT NULL DEFAULT 0,
  description         text NOT NULL,
  nutrient_focus      text[] NOT NULL DEFAULT '{}',
  npk_percentages     jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE reviews (
  id           text PRIMARY KEY,
  product_id   text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  author_name  text NOT NULL,
  rating       smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      text NOT NULL,
  date         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_product_date_idx ON reviews (product_id, date DESC);

CREATE TABLE posts (
  id            text PRIMARY KEY,
  author_name   text NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL,
  crop          text NOT NULL,
  district      text NOT NULL,
  problem_type  text NOT NULL CHECK (problem_type IN ('pest','disease','nutrientDeficiency','weather','market','general')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  like_count    integer NOT NULL DEFAULT 0 CHECK (like_count >= 0)
);
CREATE INDEX posts_created_idx ON posts (created_at DESC);

CREATE TABLE post_likes (
  post_id   text NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  owner_id  text NOT NULL,
  PRIMARY KEY (post_id, owner_id)
);

CREATE TABLE replies (
  id           text PRIMARY KEY,
  post_id      text NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_name  text NOT NULL,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX replies_post_idx ON replies (post_id, created_at);

CREATE TABLE schemes (
  id                          text PRIMARY KEY,
  seq  bigint GENERATED ALWAYS AS IDENTITY,  -- display order: catalog order is curated, not alphabetical
  name                        text NOT NULL,
  agency                      text NOT NULL,
  category                    text NOT NULL CHECK (category IN ('incomeSupport','insurance','subsidy','creditSupport','training')),
  description                 text NOT NULL,
  benefit                     text NOT NULL,
  eligibility_criteria        text[] NOT NULL DEFAULT '{}',
  max_land_holding_hectares   numeric(10,2),
  application_deadline        timestamptz
);

CREATE TABLE scheme_applications (
  owner_id      text NOT NULL,
  scheme_id     text NOT NULL REFERENCES schemes(id) ON DELETE CASCADE,
  status        text NOT NULL CHECK (status IN ('submitted','underReview','approved','rejected')),
  applied_date  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, scheme_id)
);

CREATE TABLE profiles (
  owner_id               text PRIMARY KEY,
  name                   text NOT NULL DEFAULT 'Farmer',
  village                text NOT NULL DEFAULT '',
  land_holding_hectares  numeric(10,2) NOT NULL DEFAULT 0 CHECK (land_holding_hectares >= 0)
);

CREATE TABLE farmers (
  id               text PRIMARY KEY,
  seq  bigint GENERATED ALWAYS AS IDENTITY,  -- display order: catalog order is curated, not alphabetical
  name             text NOT NULL,
  village          text NOT NULL,
  phone            text NOT NULL,
  active_crop      text NOT NULL,
  last_visit_date  timestamptz NOT NULL,
  needs_follow_up  boolean NOT NULL DEFAULT false,
  notes            text NOT NULL DEFAULT ''
);

CREATE TABLE inventory_items (
  id                   text PRIMARY KEY,
  seq  bigint GENERATED ALWAYS AS IDENTITY,  -- display order: catalog order is curated, not alphabetical
  name                 text NOT NULL,
  unit                 text NOT NULL,
  unit_price           numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  current_stock        integer NOT NULL CHECK (current_stock >= 0),
  low_stock_threshold  integer NOT NULL CHECK (low_stock_threshold >= 0)
);

CREATE TABLE restock_requests (
  id                 text PRIMARY KEY,
  item_id            text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  item_name          text NOT NULL,
  requested_quantity integer NOT NULL CHECK (requested_quantity > 0),
  status             text NOT NULL CHECK (status IN ('pending','approved','fulfilled')),
  requested_date     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX restock_requests_date_idx ON restock_requests (requested_date DESC);

CREATE TABLE orders (
  id             text PRIMARY KEY,
  customer_name  text NOT NULL,
  type           text NOT NULL CHECK (type IN ('appOrder','walkIn')),
  status         text NOT NULL CHECK (status IN ('pending','readyForPickup','completed','cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  pickup_otp     text,
  owner_id       text
);
CREATE INDEX orders_created_idx ON orders (created_at DESC);
CREATE INDEX orders_owner_idx ON orders (owner_id, created_at DESC);

CREATE TABLE order_items (
  order_id      text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position      smallint NOT NULL,
  product_name  text NOT NULL,
  quantity      integer NOT NULL CHECK (quantity > 0),
  unit_price    numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (order_id, position)
);

CREATE TABLE scans (
  id                  text PRIMARY KEY,
  owner_id            text NOT NULL,
  created_at          timestamptz NOT NULL,
  health_score        double precision NOT NULL,
  soil_moisture       double precision NOT NULL,
  nutrient_n          double precision NOT NULL,
  nutrient_p          double precision NOT NULL,
  nutrient_k          double precision NOT NULL,
  disease             text NOT NULL,
  disease_confidence  double precision NOT NULL,
  recommendations     text[] NOT NULL DEFAULT '{}',
  metadata            jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX scans_owner_created_idx ON scans (owner_id, created_at DESC);

CREATE TABLE notifications (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL,
  type        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  ref_id      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read        boolean NOT NULL DEFAULT false
);
CREATE INDEX notifications_owner_idx ON notifications (owner_id, created_at DESC);
