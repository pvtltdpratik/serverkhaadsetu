const express = require('express');
const multer = require('multer');
const { HttpError, asyncHandler, str, deviceId } = require('../utils/http');
const { analyzeImage } = require('../services/soilAnalyzer');
const { analyzeLimiter } = require('../middleware/security');
const { notify } = require('../services/notifications');

const RETENTION_DAYS = 15;
const MAX_HISTORY = 5;

// No mimetype filter on purpose: the Flutter client uploads the image bytes
// as application/octet-stream, so validating the content is left to the
// external analyzer (its 422 is relayed to the client).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 5 },
});

module.exports = (store) => {
  const router = express.Router();

  const recentScans = (device) => {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
    return store.data.scans
      .filter((s) => s.metadata.device_id === device && new Date(s.created_at).getTime() >= cutoff)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, MAX_HISTORY);
  };

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

      // Prune everything past the retention window (and past the newest
      // MAX_HISTORY for this device) so the db doesn't grow forever.
      const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
      store.data.scans = store.data.scans.filter((s) => new Date(s.created_at).getTime() >= cutoff);
      store.data.scans.push(scan);
      notify(store, device, {
        type: 'scan',
        title: 'Soil scan complete',
        body: `Your soil health score is ${Math.round(scan.health_score)}/100. Tap to see the full report.`,
        refId: scan.id,
      });
      const keep = new Set(recentScans(device).map((s) => s.id));
      store.data.scans = store.data.scans.filter((s) => s.metadata.device_id !== device || keep.has(s.id));
      store.save();

      res.json(scan);
    }),
  );

  router.get('/history', (req, res) => {
    res.json(recentScans(deviceId(req)));
  });

  router.get('/scan/:id', (req, res) => {
    const device = deviceId(req);
    const scan = recentScans(device).find((s) => s.id === req.params.id);
    if (!scan) throw new HttpError(404, 'Scan not found');
    res.json(scan);
  });

  return router;
};
