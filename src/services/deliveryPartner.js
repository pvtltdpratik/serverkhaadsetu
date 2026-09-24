const crypto = require('crypto');
const sharp = require('sharp');
const { HttpError } = require('../utils/http');
const { notify } = require('./notifications');
const { SERVICEABLE, TIME } = require('./centerService');
const { haversineKm, boundingBox } = require('./geo');

// What each kind of vehicle can honestly carry. The farmer states a capacity;
// it has to be believable for the vehicle, so a bike cannot claim two tonnes.
const VEHICLES = {
  bike: { label: 'Bike', minKg: 5, maxKg: 80 },
  pickup: { label: 'Pickup / small van', minKg: 100, maxKg: 1500 },
  tractor: { label: 'Tractor', minKg: 500, maxKg: 8000 },
};
const STATUSES = ['draft', 'pending', 'approved', 'rejected', 'suspended'];
const DOC_KINDS = ['licence', 'rc'];
const DOC_LABELS = { licence: 'driving licence', rc: 'RC (registration certificate)' };
const MAX_DOC_BYTES = 5 * 1024 * 1024;
const NEAREST_CENTER_KM = 35;
const ALL_DAYS = 127;

const PARTNER_COLUMNS = `p.user_id AS "userId", p.status, p.vehicle_type AS "vehicleType", p.vehicle_number AS "vehicleNumber",
  p.capacity_kg AS "capacityKg", p.phone, p.max_distance_km AS "maxDistanceKm", p.days AS "daysMask",
  to_char(p.free_from, 'HH24:MI') AS "freeFrom", to_char(p.free_until, 'HH24:MI') AS "freeUntil", p.online,
  p.review_center_id AS "reviewCenterId", rc.name AS "reviewCenterName", p.rejection_reason AS "rejectionReason",
  p.rating_avg AS "ratingAvg", p.rating_count AS "ratingCount", p.deliveries_done AS "deliveriesDone",
  p.submitted_at AS "submittedAt", p.reviewed_at AS "reviewedAt", p.created_at AS "createdAt",
  COALESCE(NULLIF(pr.name, ''), 'Farmer') AS "name", COALESCE(pr.village, '') AS "village"`;
const PARTNER_FROM = `delivery_partner p
  LEFT JOIN village_center rc ON rc.center_id = p.review_center_id
  LEFT JOIN profiles pr ON pr.owner_id = p.user_id`;

// ---- small pure helpers (tested directly) ---------------------------------

// Days are stored as a bitmask (bit 0 = Monday ... bit 6 = Sunday) and shown as [0..6].
const daysFromMask = (mask) => [0, 1, 2, 3, 4, 5, 6].filter((d) => (mask >> d) & 1);
const maskFromDays = (days) => days.reduce((m, d) => m | (1 << d), 0);

// "mh 12 ab 3456" -> "MH12AB3456". Loose on purpose: state formats differ and
// the operator checks the RC anyway, but it must look like a plate.
const normalizeVehicleNumber = (raw) => {
  const v = String(raw ?? '').toUpperCase().replace(/[\s-]+/g, '');
  if (!/^[A-Z0-9]{6,12}$/.test(v) || !/[A-Z]/.test(v) || !/[0-9]/.test(v)) {
    throw new HttpError(400, '"vehicleNumber" must look like a registration number, e.g. MH12AB3456');
  }
  return v;
};

// Indian mobile numbers: optional +91 / 91 / 0, then 10 digits starting 6-9.
const normalizePhone = (raw) => {
  const digits = String(raw ?? '').replace(/[\s()-]+/g, '').replace(/^\+?91/, '').replace(/^0/, '');
  if (!/^[6-9]\d{9}$/.test(digits)) throw new HttpError(400, '"phone" must be a 10-digit mobile number');
  return digits;
};

const checkCapacity = (vehicleType, capacityKg) => {
  const v = VEHICLES[vehicleType];
  if (capacityKg < v.minKg || capacityKg > v.maxKg) {
    throw new HttpError(400, `A ${v.label.toLowerCase()} can carry ${v.minKg} to ${v.maxKg} kg`);
  }
};

// Is this partner open for a job at `now`? Needs the "free now" switch on AND
// today to be one of his days AND the time to be inside his hours, all judged on
// the center's clock. Returns { free, reason }.
const availabilityAt = (partner, now, timeZone) => {
  if (partner.status !== 'approved') return { free: false, reason: 'not approved' };
  if (!partner.online) return { free: false, reason: 'switched off' };
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const mask = partner.daysMask ?? maskFromDays(partner.days || []);
  if (!((mask >> day) & 1)) return { free: false, reason: 'not one of his days' };
  if (minutes < toMin(partner.freeFrom) || minutes >= toMin(partner.freeUntil)) return { free: false, reason: 'outside his hours' };
  return { free: true, reason: '' };
};

// What is still missing before an application can be sent.
const missingFor = (row, docs) => {
  const missing = [];
  if (!row.vehicleType) missing.push('vehicleType');
  if (!row.vehicleNumber) missing.push('vehicleNumber');
  if (!row.capacityKg) missing.push('capacityKg');
  if (!row.phone) missing.push('phone');
  for (const kind of DOC_KINDS) if (!docs[kind]) missing.push(kind === 'rc' ? 'rc' : 'licence');
  return missing;
};

const MISSING_WORDS = {
  vehicleType: 'the type of vehicle', vehicleNumber: 'the vehicle number', capacityKg: 'how much it can carry',
  phone: 'your phone number', licence: 'a photo of your driving licence', rc: 'a photo of the RC',
};

// ---- reading --------------------------------------------------------------

const documentsOf = async (q, userId) => {
  const { rows } = await q.query(
    'SELECT kind, content_type AS "contentType", size_bytes AS "sizeBytes", uploaded_at AS "uploadedAt" FROM delivery_document WHERE user_id = $1',
    [userId],
  );
  const docs = { licence: null, rc: null };
  for (const r of rows) docs[r.kind] = { contentType: r.contentType, sizeBytes: r.sizeBytes, uploadedAt: r.uploadedAt };
  return docs;
};

const toView = (row, docs = null) => {
  const { daysMask, ratingAvg, ...rest } = row;
  const view = { ...rest, days: daysFromMask(daysMask), ratingAvg: Number(ratingAvg), vehicleLabel: row.vehicleType ? VEHICLES[row.vehicleType].label : null };
  if (docs) {
    view.documents = docs;
    view.missing = missingFor(row, docs);
    view.canSubmit = ['draft', 'rejected'].includes(row.status) && view.missing.length === 0;
  }
  return view;
};

const findRow = async (q, userId, { lock = false } = {}) => {
  const { rows } = await q.query(`SELECT ${PARTNER_COLUMNS} FROM ${PARTNER_FROM} WHERE p.user_id = $1${lock ? ' FOR UPDATE OF p' : ''}`, [userId]);
  return rows[0] || null;
};

// The farmer's own view. A farmer who never applied has status "none".
const getMine = async (q, userId) => {
  const row = await findRow(q, userId);
  if (!row) return { status: 'none', userId, days: daysFromMask(ALL_DAYS), maxDistanceKm: 10, freeFrom: '06:00', freeUntil: '20:00', online: false, documents: { licence: null, rc: null }, missing: [...Object.keys(MISSING_WORDS)], canSubmit: false };
  return toView(row, await documentsOf(q, userId));
};

const events = async (q, userId) =>
  (await q.query(
    `SELECT id, actor_role AS "actorRole", action, note, created_at AS "createdAt"
       FROM delivery_partner_event WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT 50`, [userId])).rows;

const logEvent = (q, userId, actor, action, note = '') =>
  q.query(
    'INSERT INTO delivery_partner_event (id, user_id, actor_id, actor_role, action, note) VALUES ($1,$2,$3,$4,$5,$6)',
    [`dpe-${crypto.randomUUID()}`, userId, actor.id || null, actor.role, action, note],
  );

const operatorOf = async (q, centerId) =>
  centerId ? (await q.query('SELECT operator_id AS "operatorId" FROM village_center WHERE center_id = $1', [centerId])).rows[0]?.operatorId : null;

const tellOperator = async (q, centerId, partnerName, title, body, userId) => {
  const operatorId = await operatorOf(q, centerId);
  if (operatorId) await notify(q, operatorId, { type: 'delivery', title, body: body.replace('{name}', partnerName), refId: userId });
};

// ---- the farmer's side ----------------------------------------------------

// Creates the application row on first use (as a draft).
const ensureRow = async (c, userId) => {
  await c.query('INSERT INTO delivery_partner (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  return findRow(c, userId, { lock: true });
};

// Changes to what was approved (the vehicle, the papers, the checking center)
// send an approved partner back for review; a rejected one goes back to draft.
const afterIdentityChange = async (c, row, actorId, why) => {
  if (row.status === 'approved') {
    await c.query("UPDATE delivery_partner SET status = 'pending', online = false, submitted_at = now(), reviewed_at = NULL, reviewed_by = NULL WHERE user_id = $1", [row.userId]);
    await logEvent(c, row.userId, { id: actorId, role: 'partner' }, 'resubmitted', why);
    await tellOperator(c, row.reviewCenterId, row.name, 'A delivery partner changed their details', `{name} changed ${why} and needs to be checked again.`, row.userId);
    return 'pending';
  }
  if (row.status === 'rejected') {
    await c.query("UPDATE delivery_partner SET status = 'draft', rejection_reason = NULL WHERE user_id = $1", [row.userId]);
    return 'draft';
  }
  return row.status;
};

const saveDetails = async (db, userId, input) => {
  const updated = await db.tx(async (c) => {
    // Serialise concurrent edits of the same person's application.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dp:${userId}`]);
    const row = await ensureRow(c, userId);
    if (row.status === 'suspended') throw new HttpError(403, 'Your delivery account is suspended. Contact your village center.');

    const next = {};
    const changedIdentity = [];
    if (input.vehicleType !== undefined) {
      if (!VEHICLES[input.vehicleType]) throw new HttpError(400, `"vehicleType" must be one of: ${Object.keys(VEHICLES).join(', ')}`);
      next.vehicle_type = input.vehicleType;
    }
    if (input.vehicleNumber !== undefined) next.vehicle_number = normalizeVehicleNumber(input.vehicleNumber);
    if (input.capacityKg !== undefined) {
      if (!Number.isInteger(input.capacityKg)) throw new HttpError(400, '"capacityKg" must be a whole number of kilograms');
      next.capacity_kg = input.capacityKg;
    }
    if (input.phone !== undefined) next.phone = normalizePhone(input.phone);
    const type = next.vehicle_type ?? row.vehicleType;
    const cap = next.capacity_kg ?? row.capacityKg;
    if (type && cap) checkCapacity(type, cap);

    if (input.maxDistanceKm !== undefined) {
      if (!Number.isInteger(input.maxDistanceKm) || input.maxDistanceKm < 1 || input.maxDistanceKm > 50) throw new HttpError(400, '"maxDistanceKm" must be a whole number from 1 to 50');
      next.max_distance_km = input.maxDistanceKm;
    }
    if (input.days !== undefined) {
      if (!Array.isArray(input.days) || !input.days.length || input.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        throw new HttpError(400, '"days" must list the days you are free, as numbers 0 (Monday) to 6 (Sunday)');
      }
      next.days = maskFromDays(input.days);
    }
    for (const [field, column] of [['freeFrom', 'free_from'], ['freeUntil', 'free_until']]) {
      if (input[field] === undefined) continue;
      if (typeof input[field] !== 'string' || !TIME.test(input[field])) throw new HttpError(400, `"${field}" must be a time like 06:30`);
      next[column] = input[field];
    }
    const from = next.free_from ?? row.freeFrom;
    const until = next.free_until ?? row.freeUntil;
    if (from >= until) throw new HttpError(400, 'You must be free from an earlier time than you are free until');

    if (input.reviewCenterId !== undefined) {
      const { rows } = await c.query(`SELECT 1 FROM village_center c WHERE c.center_id = $1 AND ${SERVICEABLE}`, [input.reviewCenterId]);
      if (!rows.length) throw new HttpError(404, 'Village center not found');
      if (input.reviewCenterId !== row.reviewCenterId) next.review_center_id = input.reviewCenterId;
    }

    for (const col of ['vehicle_type', 'vehicle_number', 'capacity_kg', 'phone', 'review_center_id']) {
      const key = { vehicle_type: 'vehicleType', vehicle_number: 'vehicleNumber', capacity_kg: 'capacityKg', phone: 'phone', review_center_id: 'reviewCenterId' }[col];
      if (next[col] !== undefined && next[col] !== row[key]) changedIdentity.push(({ vehicle_type: 'the vehicle type', vehicle_number: 'the vehicle number', capacity_kg: 'the capacity', phone: 'the phone number', review_center_id: 'the checking center' })[col]);
    }
    const sets = Object.keys(next);
    if (sets.length) {
      try {
        await c.query(`UPDATE delivery_partner SET ${sets.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE user_id = $1`, [userId, ...sets.map((k) => next[k])]);
      } catch (err) {
        if (err.code === '23505') throw new HttpError(409, 'That vehicle number is already registered by another delivery partner');
        throw err;
      }
    }
    if (changedIdentity.length) await afterIdentityChange(c, row, userId, changedIdentity.join(', '));
    return true;
  });
  return updated && getMine(db, userId);
};

// A licence or RC: a photo or a PDF, up to 5 MB, kept as sent. What the file
// really is comes from its bytes, not from the name or type the phone claims.
const detectDocument = async (buffer) => {
  if (!buffer || !buffer.length) throw new HttpError(400, 'Missing file');
  if (buffer.length > MAX_DOC_BYTES) throw new HttpError(413, 'That file is too large (max 5 MB)');
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  try {
    const { format } = await sharp(buffer).metadata();
    const type = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[format];
    if (type) return type;
  } catch {
    // falls through to the message below
  }
  throw new HttpError(422, 'Upload a photo (JPEG, PNG or WebP) or a PDF');
};

const saveDocument = async (db, userId, kind, buffer) => {
  if (!DOC_KINDS.includes(kind)) throw new HttpError(404, `Document kind must be one of: ${DOC_KINDS.join(', ')}`);
  const contentType = await detectDocument(buffer);
  await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dp:${userId}`]);
    const row = await ensureRow(c, userId);
    if (row.status === 'suspended') throw new HttpError(403, 'Your delivery account is suspended. Contact your village center.');
    await c.query(
      `INSERT INTO delivery_document (user_id, kind, content_type, size_bytes, data) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, kind) DO UPDATE SET content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data, uploaded_at = now()`,
      [userId, kind, contentType, buffer.length, buffer],
    );
    await logEvent(c, userId, { id: userId, role: 'partner' }, 'document_uploaded', kind);
    await afterIdentityChange(c, row, userId, `their ${DOC_LABELS[kind]}`);
  });
  return getMine(db, userId);
};

// Only the owner, the checking operator or an admin ever get here (the routes decide who).
const readDocument = async (q, userId, kind) => {
  if (!DOC_KINDS.includes(kind)) throw new HttpError(404, `Document kind must be one of: ${DOC_KINDS.join(', ')}`);
  const { rows } = await q.query('SELECT content_type AS "contentType", data FROM delivery_document WHERE user_id = $1 AND kind = $2', [userId, kind]);
  if (!rows.length) throw new HttpError(404, 'That document has not been uploaded');
  return rows[0];
};

// The center that will check him: the one he chose, else his home center, else
// the nearest working center to where he lives.
const chooseReviewCenter = async (c, row, userId) => {
  const candidates = [];
  if (row.reviewCenterId) candidates.push(row.reviewCenterId);
  const { rows: [profile] } = await c.query('SELECT home_center_id AS "homeCenterId", latitude, longitude FROM profiles WHERE owner_id = $1', [userId]);
  if (profile?.homeCenterId) candidates.push(profile.homeCenterId);
  for (const id of candidates) {
    const { rows } = await c.query(`SELECT c.center_id AS "centerId" FROM village_center c WHERE c.center_id = $1 AND ${SERVICEABLE}`, [id]);
    if (rows.length) return rows[0].centerId;
  }
  if (profile?.latitude != null) {
    const box = boundingBox(profile, NEAREST_CENTER_KM);
    const { rows } = await c.query(
      `SELECT c.center_id AS "centerId", c.latitude, c.longitude FROM village_center c
        WHERE ${SERVICEABLE} AND c.latitude BETWEEN $1 AND $2 AND c.longitude BETWEEN $3 AND $4`,
      [box.minLat, box.maxLat, box.minLng, box.maxLng],
    );
    const nearest = rows.map((r) => ({ ...r, km: haversineKm(profile, r) })).filter((r) => r.km <= NEAREST_CENTER_KM).sort((a, b) => a.km - b.km)[0];
    if (nearest) return nearest.centerId;
  }
  return null;
};

const submit = async (db, userId) => {
  await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dp:${userId}`]);
    const row = await findRow(c, userId, { lock: true });
    if (!row) throw new HttpError(400, 'Add your vehicle details first', { code: 'incomplete', missing: Object.keys(MISSING_WORDS) });
    if (row.status === 'pending') throw new HttpError(409, 'Your application is already waiting for the village center to check it');
    if (row.status === 'approved') throw new HttpError(409, 'You are already approved to deliver');
    if (row.status === 'suspended') throw new HttpError(403, 'Your delivery account is suspended. Contact your village center.');
    const missing = missingFor(row, await documentsOf(c, userId));
    if (missing.length) {
      throw new HttpError(400, `Before you apply, add ${missing.map((m) => MISSING_WORDS[m]).join(', ')}`, { code: 'incomplete', missing });
    }
    const centerId = await chooseReviewCenter(c, row, userId);
    if (!centerId) {
      throw new HttpError(400, 'We could not find a village center near you to check your papers. Set your location, or choose a center.', { code: 'no_center' });
    }
    try {
      await c.query(
        `UPDATE delivery_partner SET status = 'pending', review_center_id = $2, submitted_at = now(), rejection_reason = NULL,
                reviewed_at = NULL, reviewed_by = NULL, updated_at = now() WHERE user_id = $1`,
        [userId, centerId],
      );
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'That vehicle number is already registered by another delivery partner');
      throw err;
    }
    await logEvent(c, userId, { id: userId, role: 'partner' }, 'submitted');
    await tellOperator(c, centerId, row.name, 'A farmer wants to deliver', `{name} applied to deliver with a ${VEHICLES[row.vehicleType].label.toLowerCase()} (${row.vehicleNumber}). Please check the papers.`, userId);
  });
  return getMine(db, userId);
};

// The "I am free right now" switch.
const setOnline = async (db, userId, online) => {
  const { rowCount } = await db.query(
    `UPDATE delivery_partner SET online = $2, updated_at = now() WHERE user_id = $1 AND status = 'approved'`, [userId, online]);
  if (!rowCount) throw new HttpError(403, 'You can switch on delivery once the village center has approved your papers');
  return getMine(db, userId);
};

// Where he is right now: what the nearest-first matching and the buyer's live
// tracking use. Only an approved partner has a reason to share it. If he is on a
// job, the job's copy (what the buyer watches) moves too.
const setLocation = async (db, userId, { latitude, longitude }) => {
  const { rowCount } = await db.query(
    `UPDATE delivery_partner SET latitude = $2, longitude = $3, located_at = now() WHERE user_id = $1 AND status = 'approved'`, [userId, latitude, longitude]);
  if (!rowCount) throw new HttpError(403, 'Only an approved delivery partner can share a location');
  await db.query(
    `UPDATE delivery_job SET partner_latitude = $2, partner_longitude = $3, partner_located_at = now()
      WHERE partner_id = $1 AND status IN ('assigned','in_transit')`, [userId, latitude, longitude]);
};

// Stops delivering for good and removes the papers.
const withdraw = async (db, userId) => {
  const { rowCount } = await db.query('DELETE FROM delivery_partner WHERE user_id = $1', [userId]);
  if (!rowCount) throw new HttpError(404, 'You have not applied to deliver');
};

// ---- the reviewer's side (a center's operator, or an admin) ---------------

const ACTIONS = {
  approve: { from: ['pending'], to: 'approved', needsNote: false, event: 'approved',
    title: 'You are approved to deliver', body: 'Your papers were checked. Switch on "free now" when you can take deliveries.' },
  reject: { from: ['pending'], to: 'rejected', needsNote: true, event: 'rejected',
    title: 'Your delivery application needs changes', body: 'The village center could not approve it: {note}' },
  suspend: { from: ['approved'], to: 'suspended', needsNote: true, event: 'suspended',
    title: 'Your delivery account was suspended', body: 'You will not get delivery jobs for now: {note}' },
  reactivate: { from: ['suspended'], to: 'approved', needsNote: false, event: 'reactivated',
    title: 'Your delivery account is active again', body: 'You can take deliveries again.' },
};

// `actor` is { id, role: 'operator'|'admin', centerId? }. An operator may only
// act on farmers who asked THEIR center to check them (anything else is a 404,
// as if the person did not exist). `after(tx, before)` runs in the same
// transaction (the admin route uses it for its audit entry).
const review = async (db, { userId, action, note, actor, after }) => {
  const rule = ACTIONS[action];
  if (!rule) throw new HttpError(400, `Unknown action "${action}"`);
  const cleanNote = (note || '').trim();
  if (rule.needsNote && !cleanNote) throw new HttpError(400, `Say why (a short reason the farmer will see) to ${action}`);
  await db.tx(async (c) => {
    const row = await findRow(c, userId, { lock: true });
    if (!row || (actor.role === 'operator' && row.reviewCenterId !== actor.centerId)) throw new HttpError(404, 'Delivery partner not found');
    if (!rule.from.includes(row.status)) throw new HttpError(409, `A ${row.status} application cannot be ${rule.event}`);
    if (rule.to === 'approved' && action === 'approve') {
      const docs = await documentsOf(c, userId);
      if (missingFor(row, docs).length) throw new HttpError(409, 'The papers are incomplete, so this cannot be approved');
    }
    await c.query(
      `UPDATE delivery_partner SET status = $2, rejection_reason = $3, reviewed_by = $4, reviewed_at = now(),
              online = CASE WHEN $2 = 'approved' THEN online ELSE false END, updated_at = now() WHERE user_id = $1`,
      [userId, rule.to, action === 'reject' ? cleanNote : null, actor.id],
    );
    await logEvent(c, userId, actor, rule.event, cleanNote);
    await notify(c, userId, { type: 'delivery', title: rule.title, body: rule.body.replace('{note}', cleanNote), refId: userId });
    if (after) await after(c, row);
  });
  return findRow(db, userId).then((r) => toView(r, null));
};

// The reviewer's full picture of one application.
const detailFor = async (q, userId, { centerId = null } = {}) => {
  const row = await findRow(q, userId);
  // An operator only sees applications that were actually sent to their center.
  if (!row || (centerId && (row.reviewCenterId !== centerId || row.status === 'draft'))) throw new HttpError(404, 'Delivery partner not found');
  return { ...toView(row, await documentsOf(q, userId)), events: await events(q, userId) };
};

module.exports = {
  VEHICLES, STATUSES, DOC_KINDS, PARTNER_COLUMNS, PARTNER_FROM,
  daysFromMask, maskFromDays, normalizeVehicleNumber, normalizePhone, checkCapacity, availabilityAt, missingFor,
  toView, setLocation, getMine, saveDetails, saveDocument, readDocument, submit, setOnline, withdraw, review, detailFor, findRow,
};
