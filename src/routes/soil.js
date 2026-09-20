const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { HttpError, asyncHandler, str, deviceId } = require('../utils/http');
const { analyzeImage } = require('../services/soilAnalyzer');
const { analyzeLimiter } = require('../middleware/security');

const RETENTION_DAYS = 15;
const MAX_HISTORY = 5;

// No mimetype filter on purpose: the Flutter client uploads the image bytes
// as application/octet-stream, so the real check is decoding it in the
// analyzer (which rejects non-images with a 422).
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
      const device = str(metadata.device_id, 'metadata_json.device_id', { max: 100 });
      const cropType = str(metadata.crop_type, 'metadata_json.crop_type', { max: 50, optional: true });

      const analysis = await analyzeImage(req.file.buffer, { cropType });
      const scan = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ...analysis,
        metadata: { device_id: device, ...(cropType ? { crop_type: cropType } : {}) },
      };

      // Prune everything past the retention window (and past the newest
      // MAX_HISTORY for this device) so the db doesn't grow forever.
      const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
      store.data.scans = store.data.scans.filter((s) => new Date(s.created_at).getTime() >= cutoff);
      store.data.scans.push(scan);
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
