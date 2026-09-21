const express = require('express');
const multer = require('multer');
const { HttpError, asyncHandler, str, deviceId } = require('../utils/http');
const { analyzeImage } = require('../services/soilAnalyzer');
const { analyzeLimiter } = require('../middleware/security');
const { notify } = require('../services/notifications');

const SCAN_COLUMNS = 'id, created_at, health_score, soil_moisture, nutrient_n, nutrient_p, nutrient_k, disease, disease_confidence, recommendations, metadata';

const RETENTION_DAYS = 15;
const MAX_HISTORY = 5;

// No mimetype filter on purpose: the Flutter client uploads the image bytes
// as application/octet-stream, so validating the content is left to the
// external analyzer (its 422 is relayed to the client).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 5 },
});

module.exports = (db) => {
  const router = express.Router();

  // Newest MAX_HISTORY scans of the owner inside the retention window.
  const recentScans = (q, owner) =>
    q.query(
      `SELECT ${SCAN_COLUMNS} FROM scans
        WHERE owner_id = $1 AND created_at >= now() - make_interval(days => $2)
        ORDER BY created_at DESC LIMIT $3`,
      [owner, RETENTION_DAYS, MAX_HISTORY],
    ).then((r) => r.rows);

  router.post(
    '/analyze',
    analyzeLimiter,
    upload.single('image'),
    asyncHandler(async (req, res) => {
      if (!req.file) throw new HttpError(400, 'Missing "image" file field');

      let metadata;
      try {
        metadata = JSON.parse(req.body.metadata_json || '{}');
      } catch {
        throw new HttpError(400, '"metadata_json" is not valid JSON');
      }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new HttpError(400, '"metadata_json" must be a JSON object');
      }
      // The plant type may also arrive as plain `device_id` / `crop_type`
      // (or `plant_type`) form fields; metadata_json wins when both are given.
      // With auth on, the owner is always the verified user, whatever the client claims.
      const device = req.userId ?? str(metadata.device_id ?? req.body.device_id ?? req.get('x-device-id'), 'metadata_json.device_id', { max: 100 });
      const cropType = str(metadata.crop_type ?? req.body.crop_type ?? req.body.plant_type, 'metadata_json.crop_type', { max: 50, optional: true });

      const result = await analyzeImage({
        buffer: req.file.buffer,
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
        deviceId: device,
        cropType,
      });
      const scan = {
        id: result.id,
        created_at: result.created_at,
        health_score: result.health_score,
        soil_moisture: result.soil_moisture,
        nutrient_n: result.nutrient_n,
        nutrient_p: result.nutrient_p,
        nutrient_k: result.nutrient_k,
        disease: result.disease,
        disease_confidence: result.disease_confidence,
        recommendations: result.recommendations,
        metadata: { ...(result.metadata || {}), device_id: device, ...(cropType ? { crop_type: cropType } : {}) },
      };

      await db.tx(async (c) => {
        await c.query(
          `INSERT INTO scans (id, owner_id, created_at, health_score, soil_moisture, nutrient_n, nutrient_p, nutrient_k, disease, disease_confidence, recommendations, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [scan.id, device, scan.created_at, scan.health_score, scan.soil_moisture, scan.nutrient_n, scan.nutrient_p, scan.nutrient_k,
            scan.disease, scan.disease_confidence, scan.recommendations, JSON.stringify(scan.metadata)],
        );
        await notify(c, device, {
          type: 'scan',
          title: 'Soil scan complete',
          body: `Your soil health score is ${Math.round(scan.health_score)}/100. Tap to see the full report.`,
          refId: scan.id,
        });
        // Prune everything past the retention window, and everything past the
        // newest MAX_HISTORY for this owner, so the table does not grow forever.
        await c.query("DELETE FROM scans WHERE created_at < now() - make_interval(days => $1)", [RETENTION_DAYS]);
        await c.query(
          `DELETE FROM scans WHERE owner_id = $1 AND id NOT IN (
             SELECT id FROM scans WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2)`,
          [device, MAX_HISTORY],
        );
      });

      res.json(scan);
    }),
  );

  router.get('/history', asyncHandler(async (req, res) => {
    res.json(await recentScans(db, deviceId(req)));
  }));

  router.get('/scan/:id', asyncHandler(async (req, res) => {
    const scan = (await recentScans(db, deviceId(req))).find((s) => s.id === req.params.id);
    if (!scan) throw new HttpError(404, 'Scan not found');
    res.json(scan);
  }));

  return router;
};
