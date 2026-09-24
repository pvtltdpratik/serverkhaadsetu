const express = require('express');
const multer = require('multer');
const { asyncHandler, str, num, body, deviceId } = require('../utils/http');
const partners = require('../services/deliveryPartner');

// Same as the soil upload: keep the bytes in memory, and decide what they are
// from the bytes themselves (the phone's claimed type is not trusted).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 3 } });

// Everything a farmer does to become, and stay, a delivery partner. There is
// no separate login: a delivery partner is an ordinary farmer with one switch on.
module.exports = (db) => {
  const router = express.Router();
  const ah = asyncHandler;

  // My application: status, vehicle, papers on file, what is still missing.
  router.get('/partner', ah(async (req, res) => res.json(await partners.getMine(db, deviceId(req)))));

  // Vehicle, phone, how far, and when free. Send only what changed. Changing the
  // vehicle, number, capacity or phone of an approved partner sends them back
  // for a fresh check; the distance and hours are free to change.
  router.put('/partner', ah(async (req, res) => {
    const input = body(req);
    const changes = {};
    if (input.vehicleType !== undefined) changes.vehicleType = str(input.vehicleType, 'vehicleType', { max: 20 });
    if (input.vehicleNumber !== undefined) changes.vehicleNumber = str(input.vehicleNumber, 'vehicleNumber', { max: 30 });
    if (input.capacityKg !== undefined) changes.capacityKg = num(input.capacityKg, 'capacityKg', { min: 1, max: 100000, integer: true });
    if (input.phone !== undefined) changes.phone = str(input.phone, 'phone', { max: 30 });
    if (input.maxDistanceKm !== undefined) changes.maxDistanceKm = num(input.maxDistanceKm, 'maxDistanceKm', { min: 1, max: 50, integer: true });
    if (input.days !== undefined) changes.days = input.days;
    if (input.freeFrom !== undefined) changes.freeFrom = input.freeFrom;
    if (input.freeUntil !== undefined) changes.freeUntil = input.freeUntil;
    if (input.reviewCenterId !== undefined) changes.reviewCenterId = str(input.reviewCenterId, 'reviewCenterId', { max: 100 });
    res.json(await partners.saveDetails(db, deviceId(req), changes));
  }));

  // The licence or the RC, as a multipart "file" field. A photo or a PDF, up to 5 MB.
  router.post('/partner/documents/:kind', upload.single('file'), ah(async (req, res) => {
    res.status(201).json(await partners.saveDocument(db, deviceId(req), req.params.kind, req.file && req.file.buffer));
  }));

  // Your own document back, to check what you sent. Never cached, never public.
  router.get('/partner/documents/:kind', ah(async (req, res) => {
    const doc = await partners.readDocument(db, deviceId(req), req.params.kind);
    res.set({ 'Content-Type': doc.contentType, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' }).send(doc.data);
  }));

  // Sends the application to the village center for checking.
  router.post('/partner/submit', ah(async (req, res) => res.json(await partners.submit(db, deviceId(req)))));

  // "I am free right now" (approved partners only).
  router.put('/partner/online', ah(async (req, res) => {
    const { online } = body(req);
    if (typeof online !== 'boolean') return res.status(400).json({ error: '"online" must be true or false' });
    return res.json(await partners.setOnline(db, deviceId(req), online));
  }));

  // Stop delivering and remove my papers.
  router.delete('/partner', ah(async (req, res) => {
    await partners.withdraw(db, deviceId(req));
    res.status(204).end();
  }));

  return router;
};
