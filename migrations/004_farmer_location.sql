-- Where a farmer is, and which center they usually use. Coordinates come from
-- the device GPS, a dropped map pin, or (fallback) the registered village.
-- Kept on the profile so nearby-center lookups work even when the phone's
-- location is off. home_center_id gets a score bonus in center ranking.
ALTER TABLE profiles
  ADD COLUMN latitude         double precision CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN longitude        double precision CHECK (longitude BETWEEN -180 AND 180),
  ADD COLUMN location_source  text CHECK (location_source IN ('gps','village','pin')),
  ADD COLUMN home_center_id   text REFERENCES village_center(center_id) ON DELETE SET NULL,
  ADD CONSTRAINT profiles_location_pair CHECK ((latitude IS NULL) = (longitude IS NULL));
