-- The farmer's own profile, beyond a name and a village.
--
--  * contact_email / contact_phone: how the platform and centers reach the farmer.
--    They are contact details, not the login (that lives in Supabase).
--  * farmer_address: any number of saved addresses (home, farm, ...), one default.
--    Coordinates come from the phone's GPS when the farmer taps "use my location".
--  * farmer_details: what the farmer told us once so schemes can be checked without
--    asking again (category, land ownership, bank account, ...). A JSON document
--    because the set of questions grows with the schemes; the server validates it.
ALTER TABLE profiles
  ADD COLUMN contact_email text NOT NULL DEFAULT '',
  ADD COLUMN contact_phone text NOT NULL DEFAULT '';

CREATE TABLE farmer_address (
  address_id   text PRIMARY KEY,
  owner_id     text NOT NULL,
  label        text NOT NULL DEFAULT 'Home',
  full_name    text NOT NULL,
  phone        text NOT NULL,
  line1        text NOT NULL,
  line2        text NOT NULL DEFAULT '',
  landmark     text NOT NULL DEFAULT '',
  village      text NOT NULL DEFAULT '',
  taluka       text NOT NULL DEFAULT '',
  district     text NOT NULL DEFAULT '',
  state        text NOT NULL DEFAULT 'Maharashtra',
  pincode      text NOT NULL,
  latitude     double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude    double precision CHECK (longitude BETWEEN -180 AND 180),
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT farmer_address_geo_pair CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX farmer_address_owner_idx ON farmer_address (owner_id, created_at);
-- At most one default address per farmer, enforced by the database.
CREATE UNIQUE INDEX farmer_address_one_default ON farmer_address (owner_id) WHERE is_default;

CREATE TABLE farmer_details (
  owner_id    text PRIMARY KEY,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
