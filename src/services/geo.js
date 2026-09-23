const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

// Great-circle distance between two lat/long points on the Earth's surface,
// in km. Accurate over the short distances used here, unlike treating
// degrees as flat x/y (a degree of longitude shrinks away from the equator).
const haversineKm = (a, b) => {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
};

// A rectangle guaranteed to contain every point within `km` of the centre, so
// the database can pre-filter with its index before the exact distance check.
const boundingBox = ({ latitude, longitude }, km) => {
  const dLat = (km / EARTH_RADIUS_KM) * (180 / Math.PI);
  // Longitude degrees get shorter with latitude; clamp so it never blows up at the poles.
  const dLng = dLat / Math.max(Math.cos(toRad(latitude)), 0.01);
  return { minLat: latitude - dLat, maxLat: latitude + dLat, minLng: longitude - dLng, maxLng: longitude + dLng };
};

// No road data yet, so travel time is an estimate from straight-line
// distance: roads wind (x1.3) and rural travel averages about 30 km/h.
const ROAD_FACTOR = 1.3;
const RURAL_SPEED_KMH = 30;
const estimateTravelMinutes = (km) => Math.max(1, Math.round(((km * ROAD_FACTOR) / RURAL_SPEED_KMH) * 60));

module.exports = { haversineKm, boundingBox, estimateTravelMinutes };
