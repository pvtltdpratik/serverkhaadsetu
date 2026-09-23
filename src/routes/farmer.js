const express = require('express');
const { HttpError, asyncHandler, str, num, oneOf, body, deviceId, sendPaged } = require('../utils/http');
const { unreadCount, NOTIFICATION_COLUMNS } = require('../services/notifications');

const RETENTION_DAYS = 15;
const NUTRIENTS = [
  ['nutrient_n', 'Nitrogen', 'vermicompost or neem cake'],
  ['nutrient_p', 'Phosphorus', 'bone meal or rock phosphate mixed with compost'],
  ['nutrient_k', 'Potassium', 'wood ash or well-rotted compost'],
];

const defaultProfile = () => ({
  name: 'Farmer', village: '', landHoldingHectares: 0, latitude: null, longitude: null, locationSource: null, homeCenterId: null,
});

module.exports = (db) => {
  const router = express.Router();
  const ah = asyncHandler;

  const profileFor = async (q, owner) =>
    (await q.query(
      `SELECT name, village, land_holding_hectares AS "landHoldingHectares", latitude, longitude,
              location_source AS "locationSource", home_center_id AS "homeCenterId"
         FROM profiles WHERE owner_id = $1`, [owner])).rows[0];

  // The unread badge count is always derived from real notifications.
  const publicProfile = async (q, p, owner) => ({
    name: p.name,
    village: p.village,
    unreadNotificationCount: await unreadCount(q, owner),
    landHoldingHectares: p.landHoldingHectares,
    latitude: p.latitude,
    longitude: p.longitude,
    locationSource: p.locationSource,
    homeCenterId: p.homeCenterId,
  });

  router.get('/profile', ah(async (req, res) => {
    const owner = deviceId(req);
    res.json(await publicProfile(db, (await profileFor(db, owner)) || defaultProfile(), owner));
  }));

  router.put('/profile', ah(async (req, res) => {
    const owner = deviceId(req);
    const input = body(req);
    const next = await db.tx(async (c) => {
      // Lock so two simultaneous partial updates cannot overwrite each other.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`profile:${owner}`]);
      const merged = { ...defaultProfile(), ...((await profileFor(c, owner)) || {}) };
      if (input.name !== undefined) merged.name = str(input.name, 'name', { max: 80 });
      if (input.village !== undefined) merged.village = str(input.village, 'village', { max: 120 });
      if (input.landHoldingHectares !== undefined) {
        merged.landHoldingHectares = num(input.landHoldingHectares, 'landHoldingHectares', { min: 0, max: 10000 });
      }
      // Location is saved as a pair: a lone latitude is meaningless.
      if (input.latitude !== undefined || input.longitude !== undefined) {
        if (input.latitude === null && input.longitude === null) {
          merged.latitude = null;
          merged.longitude = null;
          merged.locationSource = null;
        } else {
          merged.latitude = num(input.latitude, 'latitude', { min: -90, max: 90 });
          merged.longitude = num(input.longitude, 'longitude', { min: -180, max: 180 });
          merged.locationSource = oneOf(input.locationSource === undefined ? 'gps' : input.locationSource, 'locationSource', ['gps', 'pin', 'village']);
        }
      }
      if (input.homeCenterId !== undefined) {
        if (input.homeCenterId === null) merged.homeCenterId = null;
        else {
          const id = str(input.homeCenterId, 'homeCenterId', { max: 100 });
          const found = await c.query("SELECT 1 FROM village_center WHERE center_id = $1 AND status = 'active'", [id]);
          if (!found.rows.length) throw new HttpError(404, 'Village center not found');
          merged.homeCenterId = id;
        }
      }
      await c.query(
        `INSERT INTO profiles (owner_id, name, village, land_holding_hectares, latitude, longitude, location_source, home_center_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (owner_id) DO UPDATE SET name = EXCLUDED.name, village = EXCLUDED.village,
           land_holding_hectares = EXCLUDED.land_holding_hectares, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
           location_source = EXCLUDED.location_source, home_center_id = EXCLUDED.home_center_id`,
        [owner, merged.name, merged.village, merged.landHoldingHectares, merged.latitude, merged.longitude, merged.locationSource, merged.homeCenterId],
      );
      return merged;
    });
    res.json(await publicProfile(db, next, owner));
  }));

  // ---- Notifications (created by server-side events: scans, orders, applications) ----

  router.get('/notifications', ah(async (req, res) => {
    await sendPaged(req, res, db, {
      select: NOTIFICATION_COLUMNS,
      from: `notifications WHERE owner_id = $1${req.query.unread === 'true' ? ' AND NOT read' : ''}`,
      params: [deviceId(req)],
      order: 'created_at DESC, id',
    });
  }));

  router.post('/notifications/read-all', ah(async (req, res) => {
    await db.query('UPDATE notifications SET read = true WHERE owner_id = $1', [deviceId(req)]);
    res.json({ unreadCount: 0 });
  }));

  router.post('/notifications/:id/read', ah(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE notifications SET read = true WHERE id = $1 AND owner_id = $2 RETURNING ${NOTIFICATION_COLUMNS}`,
      [req.params.id, deviceId(req)],
    );
    if (!rows.length) throw new HttpError(404, 'Notification not found');
    res.json(rows[0]);
  }));

  // The single "smart recommendation" card on the home screen, derived from
  // the owner's latest scan: dry soil > likely disease > lowest nutrient >
  // healthy/harvest, with a "scan your soil" nudge when there is no scan yet.
  router.get('/recommendation', ah(async (req, res) => {
    const latest = (await db.query(
      `SELECT soil_moisture, disease, disease_confidence, nutrient_n, nutrient_p, nutrient_k, metadata
         FROM scans WHERE owner_id = $1 AND created_at >= now() - make_interval(days => $2)
         ORDER BY created_at DESC LIMIT 1`,
      [deviceId(req), RETENTION_DAYS],
    )).rows[0];

    if (!latest) {
      return res.json({
        category: 'nutrient',
        title: 'Scan your soil to get started',
        description: 'A quick photo scan gives you a soil health score and tailored advice for your crop.',
        actionLabel: 'Scan soil',
      });
    }
    const crop = latest.metadata.crop_type ? ` ${latest.metadata.crop_type}` : '';
    if (latest.soil_moisture < 30) {
      return res.json({
        category: 'water',
        title: 'Your soil is running dry',
        description: `Your last scan shows low soil moisture. A light irrigation and mulching should help your${crop || ' crop'}.`,
        actionLabel: 'View soil report',
      });
    }
    if (latest.disease_confidence >= 60 && !latest.disease.startsWith('No significant')) {
      return res.json({
        category: 'pest',
        title: 'Check your crop for disease',
        description: `Your last scan flagged: ${latest.disease.toLowerCase()}. Inspect the plants and consider a neem-oil spray.`,
        actionLabel: 'View soil report',
      });
    }
    const [key, label, remedy] = NUTRIENTS.reduce((lowest, n) => (latest[n[0]] < latest[lowest[0]] ? n : lowest));
    if (latest[key] < 70) {
      return res.json({
        category: 'nutrient',
        title: `Time to boost ${label}`,
        description: `Your last soil scan showed ${label.toLowerCase()} is your weakest nutrient. Try ${remedy} before the next watering.`,
        actionLabel: 'View soil report',
      });
    }
    return res.json({
      category: 'harvest',
      title: 'Your soil is in good shape',
      description: 'Your last scan looks healthy. Keep up your routine and rescan in a couple of weeks.',
      actionLabel: 'View soil report',
    });
  }));

  return router;
};
