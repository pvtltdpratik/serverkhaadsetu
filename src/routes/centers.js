const express = require('express');
const { HttpError, asyncHandler, str, num, oneOf, body, deviceId } = require('../utils/http');
const { findNearby } = require('../services/nearbyCenters');
const { findVillage, searchVillages } = require('../data/villages');
const config = require('../config');

// Farmer-facing center discovery.
module.exports = (db) => {
  const router = express.Router();
  const ah = asyncHandler;

  // Village lookup for the "pick your village" fallback.
  router.get('/villages', (req, res) => res.json(searchVillages(req.query.q, 20)));

  // Ranked centers for a location and (optionally) a cart. POST because the
  // cart is a body; nothing is changed unless saveToProfile is true.
  //
  // Location, in order of preference:
  //   1. latitude + longitude in the body (GPS, or a pin the farmer dropped)
  //   2. `village` in the body
  //   3. the coordinates saved on the farmer's profile
  //   4. the farmer's registered village
  router.post('/nearby', ah(async (req, res) => {
    const owner = deviceId(req);
    const input = body(req);
    const profile = (await db.query(
      `SELECT village, latitude, longitude, location_source AS "source", home_center_id AS "homeCenterId"
         FROM profiles WHERE owner_id = $1`, [owner])).rows[0] || {};

    let origin = null;
    let source = null;
    if (input.latitude !== undefined || input.longitude !== undefined) {
      origin = {
        latitude: num(input.latitude, 'latitude', { min: -90, max: 90 }),
        longitude: num(input.longitude, 'longitude', { min: -180, max: 180 }),
      };
      source = input.locationSource === undefined ? 'gps' : oneOf(input.locationSource, 'locationSource', ['gps', 'pin']);
    } else if (input.village !== undefined) {
      const village = findVillage(str(input.village, 'village', { max: 120 }));
      if (!village) throw new HttpError(404, 'We could not find that village. Try turning on location or dropping a pin on the map.');
      origin = village;
      source = 'village';
    } else if (profile.latitude != null) {
      origin = { latitude: profile.latitude, longitude: profile.longitude };
      source = profile.source || 'gps';
    } else if (profile.village && findVillage(profile.village)) {
      origin = findVillage(profile.village);
      source = 'village';
    }
    if (!origin) throw new HttpError(400, 'Location needed: send latitude and longitude, or a village, or set your village in your profile.');

    let items = [];
    if (input.items !== undefined) {
      if (!Array.isArray(input.items) || input.items.length > 50) throw new HttpError(400, '"items" must be an array of at most 50 entries');
      const merged = new Map();
      input.items.forEach((raw, i) => {
        if (!raw || typeof raw !== 'object') throw new HttpError(400, `items[${i}] must be an object`);
        const productId = str(raw.productId, `items[${i}].productId`, { max: 100 });
        const quantity = num(raw.quantity, `items[${i}].quantity`, { min: 1, max: 10000, integer: true });
        merged.set(productId, (merged.get(productId) || 0) + quantity);
      });
      items = [...merged].map(([productId, quantity]) => ({ productId, quantity }));
      if (items.length) {
        const known = new Set((await db.query('SELECT id FROM products WHERE id = ANY($1)', [items.map((i) => i.productId)])).rows.map((r) => r.id));
        const missing = items.find((i) => !known.has(i.productId));
        if (missing) throw new HttpError(404, `Product not found: ${missing.productId}`);
      }
    }
    const limit = input.limit === undefined ? 5 : num(input.limit, 'limit', { min: 1, max: 10, integer: true });

    if (input.saveToProfile === true && source !== 'village') {
      await db.query(
        `INSERT INTO profiles (owner_id, latitude, longitude, location_source) VALUES ($1,$2,$3,$4)
         ON CONFLICT (owner_id) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, location_source = EXCLUDED.location_source`,
        [owner, origin.latitude, origin.longitude, source],
      );
    }

    const result = await findNearby(db, { origin, items, homeCenterId: profile.homeCenterId, limit, timeZone: config.centerTimezone });
    res.json({
      location: { latitude: origin.latitude, longitude: origin.longitude, source },
      radiusKm: result.radiusKm,
      centers: result.centers,
    });
  }));

  return router;
};
