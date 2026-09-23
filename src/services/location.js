const { HttpError, str, num, oneOf } = require('../utils/http');
const { findVillage } = require('../data/villages');

// Works out where a farmer is, in order of preference:
//   1. latitude + longitude in the request (GPS, or a pin they dropped)
//   2. `village` in the request
//   3. the coordinates saved on their profile
//   4. their registered village
// Returns { origin, source, profile } or null when nothing is known.
const resolveOrigin = async (db, owner, input) => {
  const profile = (await db.query(
    `SELECT village, latitude, longitude, location_source AS "source", home_center_id AS "homeCenterId"
       FROM profiles WHERE owner_id = $1`, [owner])).rows[0] || {};

  if (input.latitude !== undefined || input.longitude !== undefined) {
    const origin = {
      latitude: num(input.latitude, 'latitude', { min: -90, max: 90 }),
      longitude: num(input.longitude, 'longitude', { min: -180, max: 180 }),
    };
    const source = input.locationSource === undefined ? 'gps' : oneOf(input.locationSource, 'locationSource', ['gps', 'pin']);
    return { origin, source, profile };
  }
  if (input.village !== undefined) {
    const village = findVillage(str(input.village, 'village', { max: 120 }));
    if (!village) throw new HttpError(404, 'We could not find that village. Try turning on location or dropping a pin on the map.');
    return { origin: village, source: 'village', profile };
  }
  if (profile.latitude != null) {
    return { origin: { latitude: profile.latitude, longitude: profile.longitude }, source: profile.source || 'gps', profile };
  }
  const registered = profile.village ? findVillage(profile.village) : null;
  if (registered) return { origin: registered, source: 'village', profile };
  return null;
};

module.exports = { resolveOrigin };
