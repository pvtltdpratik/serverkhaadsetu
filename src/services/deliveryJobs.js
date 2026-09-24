const crypto = require('crypto');
const { HttpError } = require('../utils/http');
const config = require('../config');
const { notify } = require('./notifications');
const { haversineKm, boundingBox } = require('./geo');
const { roadKm, computeFee, suggestVehicle, etaMinutes } = require('./deliveryFee');
const partners = require('./deliveryPartner');
const { SERVICEABLE } = require('./centerService');

const D = config.delivery;
const MIN = 60 * 1000;
const newId = () => `job-${crypto.randomUUID()}`;
const newOtp = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');
const money = (n) => Number(n);

// ---------------------------------------------------------------------------
// What a delivery would cost
// ---------------------------------------------------------------------------

// The weight of a cart. Each line is a catalog product or a surplus lot (which
// is units of a product): what it weighs comes from the product.
const weightOf = async (q, items) => {
  const lotIds = items.filter((i) => i.surplusLotId).map((i) => i.surplusLotId);
  const lotProducts = new Map();
  if (lotIds.length) {
    const { rows } = await q.query('SELECT id, product_id FROM surplus_lot WHERE id = ANY($1)', [lotIds]);
    for (const r of rows) lotProducts.set(r.id, r.product_id);
  }
  const productIds = items.map((i) => (i.surplusLotId ? lotProducts.get(i.surplusLotId) : i.productId));
  if (productIds.some((id) => !id)) throw new HttpError(404, 'Product not found');
  const { rows } = await q.query('SELECT id, weight_kg FROM products WHERE id = ANY($1)', [productIds]);
  const kg = new Map(rows.map((r) => [r.id, Number(r.weight_kg)]));
  let total = 0;
  items.forEach((i, idx) => {
    if (!kg.has(productIds[idx])) throw new HttpError(404, 'Product not found');
    total += kg.get(productIds[idx]) * i.quantity;
  });
  return Math.round(total * 100) / 100;
};

// What delivering `items` from `center` to `drop` costs, or why it cannot be done.
const priceDelivery = async (q, { center, items, drop }) => {
  const weightKg = await weightOf(q, items);
  const straightKm = haversineKm(center, drop);
  const km = roadKm(straightKm);
  const tooFar = km > D.maxRoadKm;
  return {
    centerId: center.centerId, weightKg, roadKm: km, tooFar, maxRoadKm: D.maxRoadKm,
    fee: tooFar ? null : computeFee({ roadKm: km, weightKg }),
    suggestedVehicle: suggestVehicle(weightKg),
  };
};

// ---------------------------------------------------------------------------
// Who can take a job
// ---------------------------------------------------------------------------

// Approved partners who are free right now, carry this much, are willing to go this
// far and are not already busy, nearest to the pickup first (then the better rated).
// `job` needs {weightKg, requesterId, pickup, roadKm}; `jobId` (if any) excludes
// partners who already had an offer for it.
const eligiblePartners = async (q, { job, jobId = null, now, timeZone }) => {
  const { rows } = await q.query(
    `SELECT p.user_id AS "userId", p.status, p.vehicle_type AS "vehicleType", p.capacity_kg AS "capacityKg",
            p.max_distance_km AS "maxDistanceKm", p.days AS "daysMask",
            to_char(p.free_from, 'HH24:MI') AS "freeFrom", to_char(p.free_until, 'HH24:MI') AS "freeUntil",
            p.online, p.rating_avg AS "ratingAvg",
            COALESCE(p.latitude, pr.latitude) AS latitude, COALESCE(p.longitude, pr.longitude) AS longitude
       FROM delivery_partner p LEFT JOIN profiles pr ON pr.owner_id = p.user_id
      WHERE p.status = 'approved' AND p.online AND p.capacity_kg >= $1 AND p.user_id <> $2
        AND ($3::text IS NULL OR NOT EXISTS (SELECT 1 FROM delivery_offer o WHERE o.job_id = $3 AND o.partner_id = p.user_id AND o.status <> 'closed'))
        AND (SELECT count(*) FROM delivery_job j WHERE j.partner_id = p.user_id AND j.status IN ('assigned','in_transit')) < $4`,
    [job.weightKg, job.requesterId, jobId, D.maxActiveJobs],
  );
  return rows
    .filter((p) => p.latitude != null && partners.availabilityAt({ ...p, daysMask: p.daysMask }, now, timeZone).free)
    .map((p) => ({ ...p, toPickupKm: roadKm(haversineKm(p, job.pickup)), ratingAvg: Number(p.ratingAvg) }))
    .filter((p) => p.toPickupKm <= p.maxDistanceKm && job.roadKm <= p.maxDistanceKm)
    .sort((a, b) => a.toPickupKm - b.toPickupKm || b.ratingAvg - a.ratingAvg || (a.userId < b.userId ? -1 : 1));
};

const jobSpec = (row) => ({
  weightKg: Number(row.weight_kg), requesterId: row.requester_id, roadKm: Number(row.distance_km),
  pickup: { latitude: row.pickup_latitude, longitude: row.pickup_longitude },
});

// ---------------------------------------------------------------------------
// Creating a job, and finding it a partner
// ---------------------------------------------------------------------------

const centerOf = async (q, centerId) =>
  (await q.query('SELECT center_id AS "centerId", name, village, latitude, longitude, operator_id AS "operatorId" FROM village_center WHERE center_id = $1', [centerId])).rows[0];

const tellOperator = async (q, centerId, note) => {
  const c = centerId ? await centerOf(q, centerId) : null;
  if (c?.operatorId) await notify(q, c.operatorId, { type: 'delivery', ...note });
};

// Called inside the transaction that places an order. The fee is worked out here
// from the catalog and the map, never taken from the client. `order` is the row
// just inserted; `delivery` is {latitude, longitude, phone, label?, village?, note?}.
const createForOrder = async (c, { order, center, items, delivery, goodsAmount, now = new Date(), timeZone }) => {
  const priced = await priceDelivery(c, { center, items, drop: delivery });
  if (priced.tooFar) {
    throw new HttpError(400, `Home delivery is only available within ${D.maxRoadKm} km of the center (this is about ${priced.roadKm} km). You can collect it yourself instead.`, { code: 'delivery_too_far', roadKm: priced.roadKm, maxRoadKm: D.maxRoadKm });
  }
  const id = newId();
  await c.query(
    `INSERT INTO delivery_job (id, kind, order_id, center_id, requester_id, weight_kg, distance_km, fee, goods_amount,
        pickup_latitude, pickup_longitude, pickup_label, drop_latitude, drop_longitude, drop_label, drop_village,
        drop_phone, drop_note, pickup_otp, drop_otp, search_until)
     VALUES ($1,'center_order',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [id, order.id, center.centerId, order.ownerId, priced.weightKg, priced.roadKm, priced.fee, goodsAmount,
      center.latitude, center.longitude, `${center.name}, ${center.village}`,
      delivery.latitude, delivery.longitude, delivery.label || '', delivery.village || '',
      delivery.phone, delivery.note || '', newOtp(), newOtp(), new Date(now.getTime() + D.searchMinutes * MIN)],
  );
  // The counter code is not used for a delivery: the partner's handover code is.
  await c.query("UPDATE orders SET fulfilment = 'delivery', delivery_fee = $2, pickup_otp = NULL WHERE id = $1", [order.id, priced.fee]);
  await dispatchRound(c, id, { now, timeZone });
  return { id, ...priced };
};

// Offers the job to the next few partners, if none of the current offers is
// still open. Safe to call again and again.
const dispatchRound = async (c, jobId, { now = new Date(), timeZone = config.centerTimezone } = {}) => {
  const { rows: [job] } = await c.query('SELECT * FROM delivery_job WHERE id = $1 FOR UPDATE', [jobId]);
  if (!job || job.status !== 'open') return { offered: 0 };
  if (now >= job.search_until) {
    await fallback(c, job, 'No delivery partner was free in time');
    return { offered: 0, fellBack: true };
  }
  const { rows: [{ pending }] } = await c.query(
    "SELECT count(*)::int AS pending FROM delivery_offer WHERE job_id = $1 AND status = 'pending' AND expires_at > $2", [job.id, now]);
  if (pending > 0) return { offered: 0 };

  const candidates = (await eligiblePartners(c, { job: jobSpec(job), jobId: job.id, now, timeZone })).slice(0, D.offersPerRound);
  if (!candidates.length) {
    // Nobody free right now. Keep looking until the deadline, but ask the operator
    // to step in once so a person can phone around.
    if (!job.operator_told_at) {
      await c.query('UPDATE delivery_job SET operator_told_at = $2 WHERE id = $1', [job.id, now]);
      await tellOperator(c, job.center_id, {
        title: 'A delivery needs a driver',
        body: `No delivery partner is free for ${Number(job.weight_kg)} kg to ${job.drop_village || 'a farm'} (${Number(job.distance_km)} km). You can assign someone yourself.`,
        refId: job.order_id,
      });
    }
    return { offered: 0 };
  }
  const round = job.rounds + 1;
  const expires = new Date(now.getTime() + D.offerMinutes * MIN);
  for (const p of candidates) {
    await c.query(
      `INSERT INTO delivery_offer (job_id, partner_id, round, offered_at, expires_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (job_id, partner_id) DO UPDATE SET status = 'pending', round = EXCLUDED.round, offered_at = EXCLUDED.offered_at,
         expires_at = EXCLUDED.expires_at, responded_at = NULL`,
      [job.id, p.userId, round, now, expires],
    );
    await notify(c, p.userId, {
      type: 'delivery',
      title: `Delivery job: Rs ${money(job.fee)}`,
      body: `${Number(job.weight_kg)} kg from ${job.pickup_label} to ${job.drop_village || 'a farm'}, ${Number(job.distance_km)} km. ${p.toPickupKm} km to the pickup. Open the app to accept.`,
      refId: job.id,
    });
  }
  await c.query('UPDATE delivery_job SET rounds = $2 WHERE id = $1', [job.id, round]);
  return { offered: candidates.length };
};

// Nobody took it: the order goes back to plain pickup at the center. Nothing is stuck.
const fallback = async (c, job, reason) => {
  await c.query("UPDATE delivery_job SET status = 'fallback', cancelled_at = now(), cancelled_reason = $2 WHERE id = $1", [job.id, reason]);
  await c.query("UPDATE delivery_offer SET status = 'expired', responded_at = now() WHERE job_id = $1 AND status = 'pending'", [job.id]);
  if (job.order_id) await backToPickup(c, job, 'no_partner');
};

// Puts a delivery order back to "collect at the center" and tells the buyer their code.
const backToPickup = async (c, job, why) => {
  const otp = newOtp();
  const { rows: [order] } = await c.query(
    "UPDATE orders SET fulfilment = 'pickup', delivery_fee = 0, pickup_otp = $2 WHERE id = $1 AND status IN ('pending','readyForPickup') RETURNING owner_id AS \"ownerId\"",
    [job.order_id, otp]);
  if (!order) return;
  const center = job.center_id ? await centerOf(c, job.center_id) : null;
  const where = center ? `${center.name}, ${center.village}` : 'the village center';
  await notify(c, order.ownerId, {
    type: 'delivery',
    title: why === 'no_partner' ? 'No delivery partner was free' : 'Delivery cancelled',
    body: `Please collect your order at ${where}. Your pickup code is ${otp}. You will not be charged the delivery fee.`,
    refId: job.order_id,
  });
  if (center) {
    await tellOperator(c, job.center_id, {
      title: why === 'no_partner' ? 'Delivery fell back to pickup' : 'Delivery cancelled',
      body: 'The farmer will collect this order at the center.',
      refId: job.order_id,
    });
  }
};

// Called from the maintenance loop: closes offers nobody answered, asks the next
// partners, and gives up on jobs that have waited too long. Safe on every instance.
const runDeliveryDispatch = async (db, { now = new Date(), timeZone = config.centerTimezone } = {}) => {
  return db.tx(async (c) => {
    const { rows: [lock] } = await c.query('SELECT pg_try_advisory_xact_lock(727205) AS ok');
    if (!lock.ok) return { skipped: true, expired: 0, offered: 0, fellBack: 0 };
    const expired = await c.query("UPDATE delivery_offer SET status = 'expired', responded_at = $1 WHERE status = 'pending' AND expires_at <= $1", [now]);
    const { rows: jobs } = await c.query("SELECT id FROM delivery_job WHERE status = 'open' ORDER BY created_at FOR UPDATE SKIP LOCKED");
    let offered = 0;
    let fellBack = 0;
    for (const { id } of jobs) {
      const r = await dispatchRound(c, id, { now, timeZone });
      offered += r.offered;
      if (r.fellBack) fellBack += 1;
    }
    return { skipped: false, expired: expired.rowCount, offered, fellBack };
  });
};

// ---------------------------------------------------------------------------
// The partner answers
// ---------------------------------------------------------------------------

const partnerLine = (p) => `${p.name} (${p.vehicleLabel}, ${p.vehicleNumber}${p.ratingCount ? `, rated ${p.ratingAvg.toFixed(1)}` : ''})`;

// Common to accepting an offer and being picked by the operator.
const assign = async (c, job, partnerRow, { by, now = new Date() }) => {
  await c.query("UPDATE delivery_job SET status = 'assigned', partner_id = $2, assigned_at = $3 WHERE id = $1", [job.id, partnerRow.userId, now]);
  await c.query(
    `INSERT INTO delivery_offer (job_id, partner_id, round, status, expires_at, responded_at) VALUES ($1,$2,$3,'accepted',$4,$4)
     ON CONFLICT (job_id, partner_id) DO UPDATE SET status = 'accepted', responded_at = EXCLUDED.responded_at`,
    [job.id, partnerRow.userId, job.rounds, now]);
  await c.query("UPDATE delivery_offer SET status = 'closed', responded_at = $2 WHERE job_id = $1 AND status = 'pending' AND partner_id <> $3", [job.id, now, partnerRow.userId]);
  await notify(c, job.requester_id, {
    type: 'delivery', title: 'A delivery partner is on the way to the center',
    body: `${partnerLine(partnerRow)} will bring your order. Keep your delivery code ready.`, refId: job.order_id,
  });
  await tellOperator(c, job.center_id, {
    title: 'A delivery partner is coming for an order',
    body: `${partnerLine(partnerRow)} will collect it. Check their handover code before you give the goods.`, refId: job.order_id,
  });
  if (by === 'operator') {
    await notify(c, partnerRow.userId, {
      type: 'delivery', title: 'You were given a delivery job',
      body: `The village center assigned you ${Number(job.weight_kg)} kg from ${job.pickup_label} to ${job.drop_village || 'a farm'}. Rs ${money(job.fee)}.`, refId: job.id,
    });
  }
};

const activeJobCount = async (c, partnerId) =>
  (await c.query("SELECT count(*)::int AS n FROM delivery_job WHERE partner_id = $1 AND status IN ('assigned','in_transit')", [partnerId])).rows[0].n;

// A partner takes an offered job. The job row is locked, so of several partners
// tapping Accept together exactly one gets it and the rest are told it is gone.
const accept = async (db, partnerId, jobId, { now = new Date() } = {}) => {
  await db.tx(async (c) => {
    const { rows: [job] } = await c.query('SELECT * FROM delivery_job WHERE id = $1 FOR UPDATE', [jobId]);
    const { rows: [offer] } = job ? await c.query('SELECT * FROM delivery_offer WHERE job_id = $1 AND partner_id = $2 FOR UPDATE', [jobId, partnerId]) : { rows: [] };
    if (!job || !offer) throw new HttpError(404, 'This job was not offered to you');
    if (job.status === 'assigned' || job.status === 'in_transit') throw new HttpError(409, 'Another partner already took this job');
    if (job.status !== 'open') throw new HttpError(409, 'This job is no longer available');
    if (offer.status !== 'pending' || offer.expires_at <= now) throw new HttpError(409, 'Your offer has run out');
    const row = await partners.findRow(c, partnerId, { lock: true });
    if (!row || row.status !== 'approved') throw new HttpError(403, 'You are not approved to deliver');
    if (row.capacityKg < Number(job.weight_kg)) throw new HttpError(409, 'This load is heavier than your vehicle can carry');
    if ((await activeJobCount(c, partnerId)) >= D.maxActiveJobs) throw new HttpError(409, 'Finish your current delivery before taking another');
    await assign(c, job, partners.toView(row), { by: 'partner', now });
  });
  return jobForPartner(db, partnerId, jobId);
};

// Turns down an offer, or hands back a job he had accepted but not yet collected
// (then it goes out to other partners again, and it counts against his record).
const decline = async (db, partnerId, jobId, { now = new Date(), timeZone = config.centerTimezone } = {}) => {
  await db.tx(async (c) => {
    const { rows: [job] } = await c.query('SELECT * FROM delivery_job WHERE id = $1 FOR UPDATE', [jobId]);
    if (!job) throw new HttpError(404, 'Job not found');
    if (job.partner_id === partnerId && job.status === 'assigned') {
      await c.query("UPDATE delivery_job SET status = 'open', partner_id = NULL, assigned_at = NULL, operator_told_at = NULL WHERE id = $1", [job.id]);
      await c.query("UPDATE delivery_offer SET status = 'released', responded_at = $3 WHERE job_id = $1 AND partner_id = $2", [job.id, partnerId, now]);
      await c.query('UPDATE delivery_partner SET cancellations = cancellations + 1 WHERE user_id = $1', [partnerId]);
      await notify(c, job.requester_id, { type: 'delivery', title: 'Your delivery partner had to drop out', body: 'We are finding another one for your order.', refId: job.order_id });
      await dispatchRound(c, job.id, { now, timeZone });
      return;
    }
    if (job.partner_id === partnerId && job.status === 'in_transit') throw new HttpError(409, 'You have already collected this order. Please deliver it, or call the village center.');
    const { rows: [offer] } = await c.query('SELECT status FROM delivery_offer WHERE job_id = $1 AND partner_id = $2 FOR UPDATE', [jobId, partnerId]);
    if (!offer) throw new HttpError(404, 'This job was not offered to you');
    if (offer.status !== 'pending') throw new HttpError(409, 'You have already answered this offer');
    await c.query("UPDATE delivery_offer SET status = 'declined', responded_at = $3 WHERE job_id = $1 AND partner_id = $2", [jobId, partnerId, now]);
    // If that was the last open offer, ask the next partners straight away.
    await dispatchRound(c, jobId, { now, timeZone });
  });
};

// Ends a job for good and tells the partner (if one was on it) not to go.
const closeJob = async (c, job, status, reason) => {
  await c.query('UPDATE delivery_job SET status = $2, cancelled_at = now(), cancelled_reason = $3 WHERE id = $1', [job.id, status, reason]);
  await c.query("UPDATE delivery_offer SET status = 'expired', responded_at = now() WHERE job_id = $1 AND status = 'pending'", [job.id]);
  if (job.partner_id) {
    await notify(c, job.partner_id, { type: 'delivery', title: 'A delivery was cancelled', body: `${reason}. You do not need to go. Thank you for being ready.`, refId: job.id });
  }
};

// The order was cancelled or expired: end its delivery too. Refused once the
// goods are on the road, because by then they are not on the shelf any more.
const cancelJobForOrder = async (c, orderId, reason) => {
  const { rows: [job] } = await c.query('SELECT * FROM delivery_job WHERE order_id = $1 FOR UPDATE', [orderId]);
  if (!job || !['open', 'assigned', 'in_transit'].includes(job.status)) return;
  if (job.status === 'in_transit') {
    throw new HttpError(409, 'The order is already on its way, so it cannot be cancelled now. Please talk to the delivery partner or the village center.');
  }
  await closeJob(c, job, 'cancelled', reason);
};

// ---------------------------------------------------------------------------
// What a partner sees
// ---------------------------------------------------------------------------

const JOB_SELECT = `j.*, c.name AS center_name, c.village AS center_village, c.phone AS center_phone,
  COALESCE(NULLIF(pr.name, ''), 'Farmer') AS buyer_name`;
const JOB_FROM = `delivery_job j LEFT JOIN village_center c ON c.center_id = j.center_id
  LEFT JOIN profiles pr ON pr.owner_id = j.requester_id`;

const itemsSummary = async (q, orderId) => {
  if (!orderId) return '';
  const { rows } = await q.query('SELECT product_name, quantity FROM order_items WHERE order_id = $1 ORDER BY position', [orderId]);
  return rows.map((r) => `${r.quantity} x ${r.product_name}`).join(', ');
};

// Before accepting he sees the job, the money and the rough place, not the
// buyer's exact spot or phone. After accepting he gets everything he needs.
const partnerJobView = async (q, row, { partnerId, now = new Date(), full }) => {
  const own = row.partner_id === partnerId;
  const view = {
    id: row.id,
    kind: row.kind,
    orderId: row.order_id,
    status: row.status,
    fee: money(row.fee),
    weightKg: Number(row.weight_kg),
    distanceKm: Number(row.distance_km),
    items: await itemsSummary(q, row.order_id),
    pickup: { label: row.pickup_label, centerName: row.center_name, village: row.center_village, latitude: row.pickup_latitude, longitude: row.pickup_longitude },
    drop: { village: row.drop_village },
    mine: own,
  };
  if (row.offer_expires_at) view.offerExpiresAt = row.offer_expires_at;
  if (own && ['assigned', 'in_transit', 'delivered'].includes(row.status)) {
    view.drop = { village: row.drop_village, label: row.drop_label, latitude: row.drop_latitude, longitude: row.drop_longitude, phone: row.drop_phone, note: row.drop_note };
    view.buyerName = row.buyer_name;
    // The code he reads to the operator to get the goods; only he ever sees it.
    view.handoverCode = row.status === 'assigned' ? row.pickup_otp : null;
    // What he collects from the buyer in cash, and what of it is his.
    view.cashToCollect = money(row.goods_amount) + money(row.fee);
    view.goodsAmount = money(row.goods_amount);
    view.centerPhone = row.center_phone || '';
    view.assignedAt = row.assigned_at;
    view.pickedUpAt = row.picked_up_at;
    view.deliveredAt = row.delivered_at;
  }
  return view;
};

const jobForPartner = async (q, partnerId, jobId, { now = new Date() } = {}) => {
  const { rows: [row] } = await q.query(
    `SELECT ${JOB_SELECT}, o.expires_at AS offer_expires_at FROM ${JOB_FROM}
       LEFT JOIN delivery_offer o ON o.job_id = j.id AND o.partner_id = $2 AND o.status = 'pending' AND o.expires_at > $3
      WHERE j.id = $1 AND (j.partner_id = $2 OR EXISTS (SELECT 1 FROM delivery_offer x WHERE x.job_id = j.id AND x.partner_id = $2))`,
    [jobId, partnerId, now]);
  if (!row) throw new HttpError(404, 'Job not found');
  return partnerJobView(q, row, { partnerId, now });
};

// Jobs offered to him that he can still take.
const offersFor = async (q, partnerId, { now = new Date() } = {}) => {
  const { rows } = await q.query(
    `SELECT ${JOB_SELECT}, o.expires_at AS offer_expires_at FROM ${JOB_FROM}
       JOIN delivery_offer o ON o.job_id = j.id AND o.partner_id = $1
      WHERE o.status = 'pending' AND o.expires_at > $2 AND j.status = 'open'
      ORDER BY o.expires_at, j.id`, [partnerId, now]);
  return Promise.all(rows.map((r) => partnerJobView(q, r, { partnerId, now })));
};

// The job he is doing now (if any).
const activeFor = async (q, partnerId) => {
  const { rows } = await q.query(
    `SELECT ${JOB_SELECT} FROM ${JOB_FROM} WHERE j.partner_id = $1 AND j.status IN ('assigned','in_transit') ORDER BY j.assigned_at`, [partnerId]);
  return Promise.all(rows.map((r) => partnerJobView(q, r, { partnerId })));
};

module.exports = {
  D, newOtp, closeJob, cancelJobForOrder, weightOf, priceDelivery, eligiblePartners, jobSpec, createForOrder, dispatchRound, fallback, backToPickup,
  runDeliveryDispatch, accept, decline, assign, activeJobCount, offersFor, activeFor, jobForPartner, centerOf, tellOperator,
  JOB_SELECT, JOB_FROM, partnerJobView,
};
