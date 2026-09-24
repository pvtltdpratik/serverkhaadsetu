const express = require('express');
const multer = require('multer');
const { asyncHandler, str, num, body, deviceId } = require('../utils/http');
const partners = require('../services/deliveryPartner');
const jobs = require('../services/deliveryJobs');
const flow = require('../services/deliveryFlow');
const { otpLimiter } = require('../middleware/security');
const { resolveOrigin } = require('../services/location');
const { HttpError } = require('../utils/http');
const { haversineKm } = require('../services/geo');
const { SERVICEABLE } = require('../services/centerService');
const config = require('../config');

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

  // ---- What would a delivery cost? ----
  // Before ordering: the fee, the load, and whether a partner is free right now.
  // Without centerId the nearest working center within reach of the farm is used.
  router.post('/quote', ah(async (req, res) => {
    const input = body(req);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) throw new HttpError(400, '"items" must be an array of 1-50 entries');
    const items = input.items.map((raw, i) => {
      if (!raw || typeof raw !== 'object') throw new HttpError(400, `items[${i}] must be an object`);
      const surplusLotId = str(raw.surplusLotId, `items[${i}].surplusLotId`, { max: 100, optional: true });
      return {
        productId: surplusLotId ? undefined : str(raw.productId, `items[${i}].productId`, { max: 100 }),
        surplusLotId,
        quantity: num(raw.quantity, `items[${i}].quantity`, { min: 1, max: 100, integer: true }),
      };
    });
    const located = await resolveOrigin(db, deviceId(req), input);
    if (!located) throw new HttpError(400, 'Where should it be delivered? Send latitude and longitude.');
    const drop = located.origin;
    const centerId = str(input.centerId, 'centerId', { max: 100, optional: true });

    let center;
    if (centerId) {
      center = (await db.query(`SELECT c.center_id AS "centerId", c.name, c.village, c.latitude, c.longitude FROM village_center c WHERE c.center_id = $1 AND ${SERVICEABLE}`, [centerId])).rows[0];
      if (!center) throw new HttpError(404, 'Village center not found');
    } else {
      const { rows } = await db.query(`SELECT c.center_id AS "centerId", c.name, c.village, c.latitude, c.longitude FROM village_center c WHERE ${SERVICEABLE}`);
      center = rows.map((r) => ({ ...r, km: haversineKm(r, drop) })).sort((a, b) => a.km - b.km)[0];
      if (!center) throw new HttpError(404, 'No village center is working near you');
    }
    const priced = await jobs.priceDelivery(db, { center, items, drop });
    let partnersFree = 0;
    if (!priced.tooFar) {
      partnersFree = (await jobs.eligiblePartners(db, {
        job: { weightKg: priced.weightKg, requesterId: deviceId(req), roadKm: priced.roadKm, pickup: center }, now: new Date(), timeZone: config.centerTimezone,
      })).length;
    }
    res.json({
      centerId: center.centerId, centerName: center.name, centerVillage: center.village,
      available: !priced.tooFar, fee: priced.fee, weightKg: priced.weightKg, roadKm: priced.roadKm, maxRoadKm: priced.maxRoadKm,
      suggestedVehicle: priced.suggestedVehicle,
      // How many partners could take it this minute. Zero is not a refusal: the
      // request stays open for a while and then falls back to plain pickup.
      partnersFree,
      note: priced.tooFar
        ? `Home delivery is only available within ${priced.maxRoadKm} km of the center. You can collect it yourself instead.`
        : partnersFree
          ? 'A delivery partner nearby is free right now.'
          : 'No delivery partner is free right now. We will keep looking, and if nobody takes it you can collect it at the center for free.',
      payment: 'You pay the goods and the delivery fee in cash to the delivery partner when it arrives.',
    });
  }));

  // ---- Sharing where I am (so the nearest partner gets the offer, and the buyer can follow) ----
  router.put('/partner/location', ah(async (req, res) => {
    const input = body(req);
    await partners.setLocation(db, deviceId(req), {
      latitude: num(input.latitude, 'latitude', { min: -90, max: 90 }),
      longitude: num(input.longitude, 'longitude', { min: -180, max: 180 }),
    });
    res.status(204).end();
  }));

  // ---- Jobs ----
  // What has been offered to me and is still open, and the job I am doing now.
  router.get('/jobs/offers', ah(async (req, res) => res.json(await jobs.offersFor(db, deviceId(req)))));
  router.get('/jobs/active', ah(async (req, res) => res.json(await jobs.activeFor(db, deviceId(req)))));
  router.get('/jobs/:id', ah(async (req, res) => res.json(await jobs.jobForPartner(db, deviceId(req), req.params.id))));

  // Whoever accepts first gets it; everyone else is told it is gone (409).
  router.post('/jobs/:id/accept', ah(async (req, res) => res.json(await jobs.accept(db, deviceId(req), req.params.id))));

  // Turns an offer down, or hands back a job I accepted but have not collected yet.
  router.post('/jobs/:id/decline', ah(async (req, res) => {
    await jobs.decline(db, deviceId(req), req.params.id, { timeZone: config.centerTimezone });
    res.status(204).end();
  }));

  // The buyer reads out their delivery code when it arrives: that is the proof, and it
  // is what pays me. Wrong codes are counted (five in a row locks it for 15 minutes).
  router.post('/jobs/:id/deliver', otpLimiter, ah(async (req, res) => {
    const otp = str(body(req).otp, 'otp', { min: 4, max: 4 });
    res.json(await flow.deliver(db, { jobId: req.params.id, partnerId: deviceId(req), otp }));
  }));

  // Rate the farmer I delivered to (once, after it is done).
  router.post('/jobs/:id/rate-buyer', ah(async (req, res) => {
    const input = body(req);
    await flow.rate(db, {
      jobId: req.params.id, raterId: deviceId(req), role: 'partner_to_buyer',
      stars: num(input.stars, 'stars', { min: 1, max: 5, integer: true }),
      comment: str(input.comment, 'comment', { max: 300, optional: true }) || '',
    });
    res.status(204).end();
  }));

  // What I have earned, what I owe which center, and the latest entries.
  router.get('/wallet', ah(async (req, res) => res.json(await flow.wallet(db, deviceId(req)))));

  return router;
};
