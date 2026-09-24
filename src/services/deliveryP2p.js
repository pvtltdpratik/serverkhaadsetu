const crypto = require('crypto');
const { HttpError } = require('../utils/http');
const config = require('../config');
const { haversineKm } = require('./geo');
const partners = require('./deliveryPartner');
const jobs = require('./deliveryJobs');
const trips = require('./deliveryTrips');
const flow = require('./deliveryFlow');

// Farmer-to-farmer carriage: one farmer wants a load taken from their place to
// another farm (a resale, seed, a borrowed tool). It uses the same partners, the
// same fee, the same two codes and the same wallet as a center delivery, but no
// center and no order:
//   * the SENDER hands the load over against the partner's handover code (the
//     sender types it, like the operator does at a counter);
//   * the sender also holds the drop code and gives it to the receiver, who reads
//     it to the partner on arrival (the receiver needs no app, only a phone);
//   * the partner is paid the fee in cash by whoever agreed to pay it.

const D = config.delivery;
const MIN = 60 * 1000;
const MAX_KG = 5000;

// The moment a day ends on the center clock.
const endOfDay = (isoDay, timeZone) => {
  const guess = new Date(`${trips.addDays(isoDay, 1)}T00:00:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess).map((x) => [x.type, x.value]));
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return new Date(guess.getTime() - (local - guess.getTime()));
};

const place = (input, name) => {
  const pt = trips.point(input, name);
  return { ...pt, phone: partners.normalizePhone(input.phone), village: String(input.village || '').slice(0, 120), note: String(input.note || '').slice(0, 300) };
};

const weight = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > MAX_KG) throw new HttpError(400, `"weightKg" must be between 1 and ${MAX_KG}`);
  return Math.round(v * 100) / 100;
};

// What it would cost, and who could take it right now.
const quote = async (db, requesterId, input, { now = new Date(), timeZone = config.centerTimezone } = {}) => {
  const from = trips.point(input.from, 'from');
  const to = trips.point(input.to, 'to');
  const weightKg = weight(input.weightKg);
  const priced = jobs.priceRoute({ from, to, weightKg });
  let partnersFree = 0;
  if (!priced.tooFar) {
    partnersFree = (await jobs.eligiblePartners(db, {
      job: { weightKg, requesterId, pickup: from, drop: to, roadKm: priced.roadKm }, now, timeZone,
    })).length;
  }
  return {
    available: !priced.tooFar, fee: priced.fee, weightKg, roadKm: priced.roadKm, maxRoadKm: priced.maxRoadKm, suggestedVehicle: priced.suggestedVehicle, partnersFree,
    note: priced.tooFar
      ? `A delivery goes up to ${priced.maxRoadKm} km by road. This one is about ${priced.roadKm} km.`
      : partnersFree ? 'A delivery partner nearby is free right now.' : 'No delivery partner is free right now. We will keep looking for a while.',
    payment: 'The delivery fee is paid in cash to the delivery partner. You decide who pays it: the sender when it is collected, or the receiver on arrival.',
  };
};

const create = async (db, requesterId, input, { now = new Date(), timeZone = config.centerTimezone } = {}) => {
  const from = place(input.from, 'from');
  const to = place(input.to, 'to');
  const weightKg = weight(input.weightKg);
  const description = String(input.description || '').trim();
  if (description.length < 2 || description.length > 200) throw new HttpError(400, 'Say what is being carried, in a few words');
  const feePayer = input.feePayer === undefined ? 'sender' : input.feePayer;
  if (!['sender', 'receiver'].includes(feePayer)) throw new HttpError(400, '"feePayer" must be "sender" or "receiver"');
  if (haversineKm(from, to) < 0.3) throw new HttpError(400, 'The two places are the same. Where should it go?');
  const priced = jobs.priceRoute({ from, to, weightKg });
  if (priced.tooFar) {
    throw new HttpError(400, `A delivery goes up to ${D.maxRoadKm} km by road. This one is about ${priced.roadKm} km.`, { code: 'delivery_too_far', roadKm: priced.roadKm, maxRoadKm: D.maxRoadKm });
  }
  const id = await db.tx(async (c) => {
    // One request at a time per person is guarded by a lock so the limit holds under a burst.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`p2p:${requesterId}`]);
    const { rows: [{ n }] } = await c.query(
      "SELECT count(*)::int AS n FROM delivery_job WHERE kind = 'p2p' AND requester_id = $1 AND status IN ('open','assigned','in_transit')", [requesterId]);
    if (n >= D.maxOpenP2p) throw new HttpError(409, `You already have ${D.maxOpenP2p} requests going. Wait for one to finish, or cancel one.`);

    let tripId = null;
    let searchUntil = new Date(now.getTime() + D.searchMinutes * MIN);
    if (input.tripId !== undefined && input.tripId !== null) {
      const { rows: [t] } = await c.query("SELECT *, to_char(on_date, 'YYYY-MM-DD') AS day FROM delivery_trip WHERE id = $1 FOR UPDATE", [String(input.tripId)]);
      if (!t || t.status !== 'open') throw new HttpError(404, 'That trip is not available any more');
      const date = trips.localDate(now, timeZone);
      const tDate = t.day;
      if (tDate < date) throw new HttpError(409, 'That trip has already gone');
      if (t.partner_id === requesterId) throw new HttpError(409, 'That is your own trip');
      const left = t.spare_kg - (await trips.usedKg(c, t.id));
      if (weightKg > left) throw new HttpError(409, `That trip only has room for ${Math.max(0, left)} kg more`);
      const startsOk = haversineKm(from, { latitude: t.from_latitude, longitude: t.from_longitude }) <= D.tripMatchKm;
      const endsOk = haversineKm(to, { latitude: t.to_latitude, longitude: t.to_longitude }) <= D.tripMatchKm;
      if (!startsOk || !endsOk) throw new HttpError(409, `That trip does not pass close enough (within ${D.tripMatchKm} km) to both places`);
      tripId = t.id;
      searchUntil = endOfDay(tDate, timeZone);
    }

    const jobId = `job-${crypto.randomUUID()}`;
    await c.query(
      `INSERT INTO delivery_job (id, kind, order_id, center_id, requester_id, weight_kg, distance_km, fee, goods_amount,
          pickup_latitude, pickup_longitude, pickup_label, pickup_phone, drop_latitude, drop_longitude, drop_label, drop_village,
          drop_phone, drop_note, pickup_otp, drop_otp, search_until, description, fee_payer, trip_id)
       VALUES ($1,'p2p',NULL,NULL,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [jobId, requesterId, weightKg, priced.roadKm, priced.fee, from.latitude, from.longitude, from.label, from.phone,
        to.latitude, to.longitude, to.label, to.village, to.phone, to.note, jobs.newOtp(), jobs.newOtp(), searchUntil, description, feePayer, tripId]);
    await jobs.dispatchRound(c, jobId, { now, timeZone });
    return jobId;
  });
  return view(db, id);
};

// The sender's own view (the same shape as a buyer's delivery, plus the parcel).
const view = async (q, jobId) => {
  const v = await flow.requesterView(q, jobId);
  if (!v) throw new HttpError(404, 'Request not found');
  return v;
};

const mine = async (q, requesterId, { limit = 30 } = {}) => {
  const { rows } = await q.query("SELECT id FROM delivery_job WHERE kind = 'p2p' AND requester_id = $1 ORDER BY created_at DESC, id LIMIT $2", [requesterId, limit]);
  return Promise.all(rows.map((r) => flow.requesterView(q, r.id)));
};

const ownJob = async (q, requesterId, jobId) => {
  const { rows: [j] } = await q.query("SELECT id FROM delivery_job WHERE id = $1 AND kind = 'p2p' AND requester_id = $2", [jobId, requesterId]);
  if (!j) throw new HttpError(404, 'Request not found');
};

const get = async (q, requesterId, jobId) => {
  await ownJob(q, requesterId, jobId);
  return view(q, jobId);
};

// Called off by the sender, until the load is on the road.
const cancel = async (db, requesterId, jobId) => {
  await ownJob(db, requesterId, jobId);
  await db.tx(async (c) => {
    const { rows: [job] } = await c.query('SELECT * FROM delivery_job WHERE id = $1 FOR UPDATE', [jobId]);
    if (job.status === 'in_transit') throw new HttpError(409, 'It is already on the road. Please talk to the delivery partner.');
    if (!['open', 'assigned'].includes(job.status)) throw new HttpError(409, `This request is ${job.status === 'delivered' ? 'already done' : 'no longer active'}`);
    await jobs.closeJob(c, job, 'cancelled', 'The sender cancelled the request');
  });
  return view(db, jobId);
};

module.exports = { quote, create, mine, get, cancel, endOfDay };
