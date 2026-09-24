const crypto = require('crypto');
const { HttpError } = require('../utils/http');
const config = require('../config');
const { notify } = require('./notifications');
const { haversineKm } = require('./geo');
const partners = require('./deliveryPartner');

// A trip is a delivery partner saying "I am going from here to there on this day
// and have room for this many kilos". Farmers can book that room (a farmer-to-farmer
// job, see deliveryP2p) and a delivery order along the same road is offered to him
// first. Only approved partners may post one: the papers were checked.

const D = config.delivery;
const MAX_DAYS_AHEAD = 14;
const MAX_OPEN_TRIPS = 10;
const newId = () => `trip-${crypto.randomUUID()}`;

// "2026-09-24" on the center's clock.
const localDate = (now, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

const addDays = (isoDay, days) => {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const validDay = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new HttpError(400, '"date" must be a day like 2026-09-25');
  }
  return v;
};

// How much of a trip's room is spoken for: every booking that is still on, or done.
const usedKg = async (q, tripId) => Number((await q.query(
  `SELECT COALESCE(SUM(weight_kg), 0) AS kg FROM delivery_job WHERE trip_id = $1 AND status IN ('open','assigned','in_transit','delivered')`, [tripId])).rows[0].kg);

const TRIP_SELECT = `t.id, t.partner_id AS "partnerId", t.from_latitude AS "fromLatitude", t.from_longitude AS "fromLongitude", t.from_label AS "fromLabel",
  t.to_latitude AS "toLatitude", t.to_longitude AS "toLongitude", t.to_label AS "toLabel", to_char(t.on_date, 'YYYY-MM-DD') AS date,
  t.spare_kg AS "spareKg", t.note, t.status,
  COALESCE((SELECT SUM(j.weight_kg) FROM delivery_job j WHERE j.trip_id = t.id AND j.status IN ('open','assigned','in_transit','delivered')), 0) AS "usedKg",
  (SELECT count(*)::int FROM delivery_job j WHERE j.trip_id = t.id AND j.status IN ('open','assigned','in_transit','delivered')) AS bookings`;

const shape = (r) => ({ ...r, usedKg: Number(r.usedKg), leftKg: Math.max(0, r.spareKg - Number(r.usedKg)) });

const point = (input, name) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, `"${name}" must be a place with latitude and longitude`);
  const { latitude, longitude } = input;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new HttpError(400, `"${name}" needs a valid latitude and longitude`);
  }
  return { latitude, longitude, label: String(input.label || '').slice(0, 120) };
};

const tripById = async (q, id) => {
  const { rows: [r] } = await q.query(`SELECT ${TRIP_SELECT} FROM delivery_trip t WHERE t.id = $1`, [id]);
  if (!r) throw new HttpError(404, 'Trip not found');
  return shape(r);
};

const createTrip = async (db, userId, input, { now = new Date(), timeZone = config.centerTimezone } = {}) => {
  const from = point(input.from, 'from');
  const to = point(input.to, 'to');
  const date = validDay(input.date);
  const today = localDate(now, timeZone);
  if (date < today) throw new HttpError(400, 'That day has already passed');
  if (date > addDays(today, MAX_DAYS_AHEAD)) throw new HttpError(400, `You can post a trip up to ${MAX_DAYS_AHEAD} days ahead`);
  if (haversineKm(from, to) < 1) throw new HttpError(400, 'The two places are the same. Where are you going?');
  const note = String(input.note || '').slice(0, 300);
  return db.tx(async (c) => {
    const row = await partners.findRow(c, userId, { lock: true });
    if (!row || row.status !== 'approved') throw new HttpError(403, 'Only an approved delivery partner can post a trip');
    if (!Number.isInteger(input.spareKg) || input.spareKg < 1 || input.spareKg > row.capacityKg) {
      throw new HttpError(400, `Room to spare must be between 1 and ${row.capacityKg} kg (what your vehicle carries)`);
    }
    const { rows: [{ n }] } = await c.query("SELECT count(*)::int AS n FROM delivery_trip WHERE partner_id = $1 AND status = 'open' AND on_date >= $2", [userId, today]);
    if (n >= MAX_OPEN_TRIPS) throw new HttpError(409, `You already have ${MAX_OPEN_TRIPS} trips posted. Cancel one first.`);
    const id = newId();
    await c.query(
      `INSERT INTO delivery_trip (id, partner_id, from_latitude, from_longitude, from_label, to_latitude, to_longitude, to_label, on_date, spare_kg, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, userId, from.latitude, from.longitude, from.label, to.latitude, to.longitude, to.label, date, input.spareKg, note]);
    return tripById(c, id);
  });
};

// My trips that are still to come.
const listMine = async (q, userId, { now = new Date(), timeZone = config.centerTimezone } = {}) => {
  const { rows } = await q.query(
    `SELECT ${TRIP_SELECT} FROM delivery_trip t WHERE t.partner_id = $1 AND t.status = 'open' AND t.on_date >= $2 ORDER BY t.on_date, t.created_at`,
    [userId, localDate(now, timeZone)]);
  return rows.map(shape);
};

// Called off. Bookings not yet collected go back to the general pool (the sender
// is told); once he has accepted one he must hand it back first.
const cancelTrip = async (db, userId, tripId, { now = new Date(), timeZone = config.centerTimezone } = {}) => {
  const { dispatchRound } = require('./deliveryJobs'); // late: deliveryJobs needs this file
  await db.tx(async (c) => {
    const { rows: [t] } = await c.query('SELECT * FROM delivery_trip WHERE id = $1 AND partner_id = $2 FOR UPDATE', [tripId, userId]);
    if (!t) throw new HttpError(404, 'Trip not found');
    if (t.status === 'cancelled') return;
    const { rows: jobs } = await c.query("SELECT * FROM delivery_job WHERE trip_id = $1 AND status IN ('open','assigned','in_transit') FOR UPDATE", [tripId]);
    if (jobs.some((j) => j.status !== 'open')) throw new HttpError(409, 'You have already accepted a booking on this trip. Hand it back from the job, or finish it, first.');
    await c.query("UPDATE delivery_trip SET status = 'cancelled' WHERE id = $1", [tripId]);
    for (const j of jobs) {
      await c.query('UPDATE delivery_job SET trip_id = NULL WHERE id = $1', [j.id]);
      await c.query("UPDATE delivery_offer SET status = 'released', responded_at = $3 WHERE job_id = $1 AND partner_id = $2 AND status = 'pending'", [j.id, userId, now]);
      await notify(c, j.requester_id, { type: 'delivery', title: 'The trip you booked was called off', body: 'We are looking for another delivery partner for your load.', refId: j.id });
      await dispatchRound(c, j.id, { now, timeZone });
    }
  });
};

// Trips other farmers can book: coming up, with room, starting near `near`.
const board = async (q, { near, viewerId, weightKg = 0, now = new Date(), timeZone = config.centerTimezone, withinKm = 25 }) => {
  const { rows } = await q.query(
    `SELECT ${TRIP_SELECT}, COALESCE(NULLIF(pr.name, ''), 'Farmer') AS "partnerName", p.vehicle_type AS "vehicleType",
            p.rating_avg AS "ratingAvg", p.rating_count AS "ratingCount", p.deliveries_done AS "deliveriesDone"
       FROM delivery_trip t JOIN delivery_partner p ON p.user_id = t.partner_id LEFT JOIN profiles pr ON pr.owner_id = t.partner_id
      WHERE t.status = 'open' AND t.on_date >= $1 AND p.status = 'approved' AND t.partner_id <> $2
      ORDER BY t.on_date, t.created_at LIMIT 200`, [localDate(now, timeZone), viewerId]);
  return rows
    .map((r) => ({ ...shape(r), ratingAvg: Number(r.ratingAvg), fromKm: near ? Math.round(haversineKm(near, { latitude: r.fromLatitude, longitude: r.fromLongitude }) * 10) / 10 : null }))
    .filter((t) => t.leftKg >= Math.max(1, weightKg) && (near == null || t.fromKm <= withinKm))
    .slice(0, 30);
};

// Partners with a trip today that runs along this job (pickup near the start, drop
// near the end) and room left. Used by the dispatcher: they are asked first.
const tripPartnersFor = async (q, { job, now, timeZone }) => {
  if (!job.pickup || !job.drop) return [];
  const { rows } = await q.query(
    `SELECT t.id AS "tripId", t.partner_id AS "userId", t.spare_kg AS "spareKg", t.from_latitude AS "fromLatitude", t.from_longitude AS "fromLongitude",
            t.to_latitude AS "toLatitude", t.to_longitude AS "toLongitude",
            COALESCE((SELECT SUM(j.weight_kg) FROM delivery_job j WHERE j.trip_id = t.id AND j.status IN ('open','assigned','in_transit','delivered')), 0) AS "usedKg"
       FROM delivery_trip t JOIN delivery_partner p ON p.user_id = t.partner_id
      WHERE t.status = 'open' AND t.on_date = $1 AND p.status = 'approved' AND t.partner_id <> $2`,
    [localDate(now, timeZone), job.requesterId]);
  return rows.filter((t) => t.spareKg - Number(t.usedKg) >= job.weightKg
    && haversineKm(job.pickup, { latitude: t.fromLatitude, longitude: t.fromLongitude }) <= D.tripMatchKm
    && haversineKm(job.drop, { latitude: t.toLatitude, longitude: t.toLongitude }) <= D.tripMatchKm);
};

module.exports = { localDate, addDays, validDay, usedKg, createTrip, tripById, listMine, cancelTrip, board, tripPartnersFor, point, MAX_DAYS_AHEAD };
