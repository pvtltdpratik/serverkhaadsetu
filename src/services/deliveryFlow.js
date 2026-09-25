const crypto = require('crypto');
const { HttpError } = require('../utils/http');
const { notify } = require('./notifications');
const { haversineKm } = require('./geo');
const { roadKm, etaMinutes } = require('./deliveryFee');
const partners = require('./deliveryPartner');
const jobs = require('./deliveryJobs');
const { findOrder } = require('./orders');
const { consumeOrderStock } = require('./reservations');

// The second half of a delivery: handing the goods over, delivering them, the
// buyer following along, the partner's money, and the ratings. The two codes are
// the proof of who took the goods and who received them.

const MAX_WRONG_CODES = 5;
const LOCK_MINUTES = 15;
const MIN = 60 * 1000;
const money = (n) => Number(n);

const sameCode = (expected, given) => {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(given || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Checks a code, keeping count of wrong tries. Returns null when right, or the
// message to show. The counters are written by the caller's transaction, so a
// wrong code must be reported AFTER the transaction commits (see `guarded`).
// Five wrong in a row locks that step for 15 minutes.
const judgeCode = async (c, job, step, given, now) => {
  const lockedUntil = job[`${step}_locked_until`];
  if (lockedUntil && lockedUntil > now) {
    const mins = Math.max(1, Math.ceil((lockedUntil - now) / MIN));
    throw new HttpError(429, `Too many wrong codes. Please wait ${mins} minute${mins === 1 ? '' : 's'} and try again.`);
  }
  if (sameCode(job[`${step}_otp`], given)) {
    await c.query(`UPDATE delivery_job SET ${step}_failed = 0, ${step}_locked_until = NULL WHERE id = $1`, [job.id]);
    return null;
  }
  const failed = job[`${step}_failed`] + 1;
  if (failed >= MAX_WRONG_CODES) {
    await c.query(`UPDATE delivery_job SET ${step}_failed = 0, ${step}_locked_until = $2 WHERE id = $1`, [job.id, new Date(now.getTime() + LOCK_MINUTES * MIN)]);
    return { message: `That code is wrong. Too many wrong tries: this step is locked for ${LOCK_MINUTES} minutes.`, attemptsLeft: 0 };
  }
  await c.query(`UPDATE delivery_job SET ${step}_failed = $2 WHERE id = $1`, [job.id, failed]);
  const left = MAX_WRONG_CODES - failed;
  return { message: `That code is wrong. ${left} ${left === 1 ? 'try' : 'tries'} left.`, attemptsLeft: left };
};

// Runs `work(c)` in a transaction. If it returns { wrong }, the wrong-code count
// is kept (the transaction commits) and only then is the error raised.
const guarded = async (db, work) => {
  const out = await db.tx(work);
  if (out && out.wrong) throw new HttpError(400, out.wrong.message, { attemptsLeft: out.wrong.attemptsLeft });
  return out;
};

const ledger = (c, { partnerId, jobId, centerId, kind, amount, note = '', actorId = null }) =>
  c.query(
    'INSERT INTO delivery_ledger (id, partner_id, job_id, center_id, kind, amount, note, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [`led-${crypto.randomUUID()}`, partnerId, jobId, centerId, kind, amount, note, actorId],
  );

const partnerName = async (q, userId) =>
  (await q.query("SELECT COALESCE(NULLIF(name, ''), 'Farmer') AS name FROM profiles WHERE owner_id = $1", [userId])).rows[0]?.name || 'Farmer';

// ---------------------------------------------------------------------------
// At the counter: the operator hands the goods to the partner
// ---------------------------------------------------------------------------

// The partner reads the code from his app; the operator types it. Only then do
// the goods leave the shelf and the buyer is told they are on the way.
const handover = async (db, { jobId, centerId, otp, now = new Date() }) => {
  await guarded(db, async (c) => {
    const { rows: [job] } = await c.query('SELECT * FROM delivery_job WHERE id = $1 FOR UPDATE', [jobId]);
    if (!job || job.center_id !== centerId) throw new HttpError(404, 'Delivery not found');
    if (job.status === 'open') throw new HttpError(409, 'No delivery partner has taken this job yet');
    if (job.status === 'in_transit') throw new HttpError(409, 'These goods were already handed over');
    if (job.status !== 'assigned') throw new HttpError(409, `This delivery is ${job.status === 'delivered' ? 'already done' : 'not active'}`);
    const wrong = await judgeCode(c, job, 'pickup', otp, now);
    if (wrong) return { wrong };

    const order = await findOrder(c, job.order_id, { lock: true });
    await require('./resale').assertHandable(c, order); // goods a farmer has not yet brought in cannot go out
    await consumeOrderStock(c, order); // the goods leave the shelf now
    await c.query("UPDATE orders SET status = 'readyForPickup' WHERE id = $1 AND status = 'pending'", [order.id]);
    await c.query("UPDATE delivery_job SET status = 'in_transit', picked_up_at = $2 WHERE id = $1", [job.id, now]);
    const name = await partnerName(c, job.partner_id);
    await notify(c, job.requester_id, {
      type: 'delivery', title: 'Your order is on its way',
      body: `${name} has collected it. When it arrives, give them your delivery code ${job.drop_otp} and pay Rs ${money(job.goods_amount) + money(job.fee)} in cash.`,
      refId: job.order_id,
    });
    return {};
  });
  return operatorJobView(db, jobId);
};

// A farmer-to-farmer load: the SENDER types the partner's handover code.
const handoverByRequester = async (db, { jobId, requesterId, otp, now = new Date() }) => {
  await guarded(db, async (c) => {
    const { rows: [job] } = await c.query("SELECT * FROM delivery_job WHERE id = $1 AND kind = 'p2p' FOR UPDATE", [jobId]);
    if (!job || job.requester_id !== requesterId) throw new HttpError(404, 'Request not found');
    if (job.status === 'open') throw new HttpError(409, 'No delivery partner has taken this yet');
    if (job.status === 'in_transit') throw new HttpError(409, 'This was already handed over');
    if (job.status !== 'assigned') throw new HttpError(409, `This request is ${job.status === 'delivered' ? 'already done' : 'not active'}`);
    const wrong = await judgeCode(c, job, 'pickup', otp, now);
    if (wrong) return { wrong };
    await c.query("UPDATE delivery_job SET status = 'in_transit', picked_up_at = $2 WHERE id = $1", [job.id, now]);
    await notify(c, job.partner_id, {
      type: 'delivery', title: 'Handed over: on your way',
      body: `Take it to ${job.drop_village || job.drop_label || 'the receiver'}. The receiver will give you the delivery code.`, refId: job.id,
    });
    return {};
  });
  return requesterView(db, jobId);
};

// ---------------------------------------------------------------------------
// At the farm: the partner delivers
// ---------------------------------------------------------------------------

// The buyer reads out the second code. That is the proof it arrived, and it is
// what pays the partner.
const deliver = async (db, { jobId, partnerId, otp, now = new Date() }) => {
  await guarded(db, async (c) => {
    const { rows: [job] } = await c.query('SELECT * FROM delivery_job WHERE id = $1 FOR UPDATE', [jobId]);
    if (!job || job.partner_id !== partnerId) throw new HttpError(404, 'Job not found');
    if (job.status === 'assigned') throw new HttpError(409, 'Collect the goods from the village center first');
    if (job.status === 'delivered') throw new HttpError(409, 'This delivery is already done');
    if (job.status !== 'in_transit') throw new HttpError(409, 'This delivery is not active');
    const wrong = await judgeCode(c, job, 'drop', otp, now);
    if (wrong) return { wrong };

    await c.query("UPDATE delivery_job SET status = 'delivered', delivered_at = $2 WHERE id = $1", [job.id, now]);
    if (job.kind === 'p2p') {
      // No center and no goods money: he earned the fee, paid to him in cash by whoever agreed to.
      await c.query('UPDATE delivery_partner SET deliveries_done = deliveries_done + 1 WHERE user_id = $1', [partnerId]);
      await ledger(c, { partnerId, jobId, centerId: null, kind: 'fee_earned', amount: money(job.fee), note: 'Delivery fee (farmer to farmer)' });
      const who = await partnerName(c, partnerId);
      await notify(c, job.requester_id, { type: 'delivery', title: 'Delivered', body: `${who} delivered your load. Please rate the delivery.`, refId: job.id });
      await notify(c, partnerId, { type: 'delivery', title: `You earned Rs ${money(job.fee)}`, body: 'Delivery done. The fee is yours to keep from the cash you were given.', refId: job.id });
      return {};
    }
    await c.query("UPDATE orders SET status = 'completed', pickup_otp = NULL WHERE id = $1", [job.order_id]);
    // The first center a farmer actually gets an order from becomes their home center.
    await c.query(
      `INSERT INTO profiles (owner_id, home_center_id) VALUES ($1,$2)
       ON CONFLICT (owner_id) DO UPDATE SET home_center_id = COALESCE(profiles.home_center_id, EXCLUDED.home_center_id)`,
      [job.requester_id, job.center_id]);
    await c.query('UPDATE delivery_partner SET deliveries_done = deliveries_done + 1 WHERE user_id = $1', [partnerId]);
    // He keeps the fee out of the cash he collected, and owes the center the goods amount.
    await ledger(c, { partnerId, jobId, centerId: job.center_id, kind: 'fee_earned', amount: money(job.fee), note: 'Delivery fee' });
    if (money(job.goods_amount) > 0) {
      await ledger(c, { partnerId, jobId, centerId: job.center_id, kind: 'goods_owed', amount: money(job.goods_amount), note: 'Cash for the goods, to hand to the center' });
    }
    const name = await partnerName(c, partnerId);
    await notify(c, job.requester_id, { type: 'delivery', title: 'Delivered', body: `Thank you! ${name} delivered your order. Please rate the delivery.`, refId: job.order_id });
    await notify(c, partnerId, {
      type: 'delivery', title: `You earned Rs ${money(job.fee)}`,
      body: `Delivery done. Keep your fee and hand Rs ${money(job.goods_amount)} to the village center.`, refId: job.id,
    });
    await jobs.tellOperator(c, job.center_id, {
      title: 'A delivery was completed', body: `${name} delivered an order. They owe the center Rs ${money(job.goods_amount)} for the goods.`, refId: job.order_id,
    });
    return {};
  });
  return jobs.jobForPartner(db, partnerId, jobId);
};

// ---------------------------------------------------------------------------
// The buyer follows along
// ---------------------------------------------------------------------------

const STAGES = {
  open: 'Finding a delivery partner',
  assigned: 'Your delivery partner is on the way to the center',
  in_transit: 'Your order is on its way to you',
  delivered: 'Delivered',
  cancelled: 'Delivery cancelled',
  fallback: 'No delivery partner was free: collect it at the center',
};

const P2P_STAGES = {
  open: 'Finding a delivery partner',
  assigned: 'Your delivery partner is coming to collect it',
  in_transit: 'On its way to the receiver',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  fallback: 'No delivery partner was free',
};

const buyerViewOf = (row) => {
  const active = ['assigned', 'in_transit'].includes(row.status);
  const p2p = row.kind === 'p2p';
  const view = {
    jobId: row.id, kind: row.kind, status: row.status, stage: (p2p ? P2P_STAGES : STAGES)[row.status], fee: money(row.fee),
    weightKg: Number(row.weight_kg), distanceKm: Number(row.distance_km),
    payableAmount: money(row.goods_amount) + money(row.fee),
    ...(p2p ? {
      description: row.description, feePayer: row.fee_payer, receiverPhone: row.drop_phone, senderPhone: row.pickup_phone,
      canCancel: ['open', 'assigned'].includes(row.status), tripId: row.trip_id,
    } : {}),
    pickup: { latitude: row.pickup_latitude, longitude: row.pickup_longitude, label: row.pickup_label },
    drop: { latitude: row.drop_latitude, longitude: row.drop_longitude, label: row.drop_label },
    partner: null, partnerLocation: null, dropCode: null, nextStop: null, distanceToNextStopKm: null, etaMinutes: null,
    canSwitchToPickup: !p2p && ['open', 'assigned'].includes(row.status),
    rated: Boolean(row.buyer_rating),
    searchUntil: row.status === 'open' ? row.search_until : null,
  };
  if (row.partner_id && ['assigned', 'in_transit', 'delivered'].includes(row.status)) {
    view.partner = {
      name: row.partner_name, vehicleType: row.vehicle_type, vehicleLabel: row.vehicle_label, vehicleNumber: row.vehicle_number,
      ratingAvg: Number(row.rating_avg), ratingCount: row.rating_count, deliveriesDone: row.deliveries_done, phone: row.partner_phone,
    };
  }
  // The buyer's code to read out, from the moment someone is coming.
  if (active) view.dropCode = row.drop_otp;
  if (active && row.partner_latitude != null) {
    view.partnerLocation = { latitude: row.partner_latitude, longitude: row.partner_longitude, updatedAt: row.partner_located_at };
    const target = row.status === 'assigned' ? { latitude: row.pickup_latitude, longitude: row.pickup_longitude } : { latitude: row.drop_latitude, longitude: row.drop_longitude };
    const km = roadKm(haversineKm({ latitude: row.partner_latitude, longitude: row.partner_longitude }, target));
    view.nextStop = row.status === 'assigned' ? (p2p ? 'pickup' : 'center') : (p2p ? 'receiver' : 'you');
    view.distanceToNextStopKm = km;
    // Heading to the center, the trip to the farm still follows.
    view.etaMinutes = etaMinutes(km + (row.status === 'assigned' ? Number(row.distance_km) : 0), row.vehicle_type);
  }
  return view;
};

const BUYER_SELECT = `j.*, dp.vehicle_type, dp.vehicle_number, dp.rating_avg, dp.rating_count, dp.deliveries_done, dp.phone AS partner_phone,
  COALESCE(NULLIF(pp.name, ''), 'Farmer') AS partner_name,
  CASE dp.vehicle_type WHEN 'bike' THEN 'Bike' WHEN 'pickup' THEN 'Pickup / small van' WHEN 'tractor' THEN 'Tractor' END AS vehicle_label,
  (SELECT stars FROM delivery_rating r WHERE r.job_id = j.id AND r.role = 'buyer_to_partner') AS buyer_rating`;
const BUYER_FROM = `delivery_job j LEFT JOIN delivery_partner dp ON dp.user_id = j.partner_id LEFT JOIN profiles pp ON pp.owner_id = j.partner_id`;

// The tracking view for one order (the buyer's own, the caller checks whose).
const buyerDelivery = async (q, orderId) => {
  const { rows: [row] } = await q.query(`SELECT ${BUYER_SELECT} FROM ${BUYER_FROM} WHERE j.order_id = $1`, [orderId]);
  return row ? buyerViewOf(row) : null;
};

// The sender's tracking view of a farmer-to-farmer request.
const requesterView = async (q, jobId) => {
  const { rows: [row] } = await q.query(`SELECT ${BUYER_SELECT} FROM ${BUYER_FROM} WHERE j.id = $1 AND j.kind = 'p2p'`, [jobId]);
  return row ? buyerViewOf(row) : null;
};

// The same for a page of orders, in one query.
const buyerDeliveries = async (q, orderIds) => {
  if (!orderIds.length) return new Map();
  const { rows } = await q.query(`SELECT ${BUYER_SELECT} FROM ${BUYER_FROM} WHERE j.order_id = ANY($1)`, [orderIds]);
  return new Map(rows.map((r) => [r.order_id, buyerViewOf(r)]));
};

// The buyer decides to collect it themselves after all (before it is on the road).
const switchToPickup = async (db, { orderId, buyerId }) => {
  await db.tx(async (c) => {
    const { rows: [job] } = await c.query('SELECT * FROM delivery_job WHERE order_id = $1 FOR UPDATE', [orderId]);
    if (!job || job.requester_id !== buyerId) throw new HttpError(404, 'This order has no delivery');
    if (job.status === 'in_transit') throw new HttpError(409, 'Your order is already on its way. Please wait for it, or call the delivery partner.');
    if (!['open', 'assigned'].includes(job.status)) throw new HttpError(409, `This delivery is ${job.status === 'delivered' ? 'already done' : 'no longer active'}`);
    await jobs.closeJob(c, job, 'cancelled', 'The buyer chose to collect the order');
    await jobs.backToPickup(c, job, 'buyer');
  });
  return buyerDelivery(db, orderId);
};

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

// Each side rates the other, once, after the delivery is done.
const rate = async (db, { jobId, raterId, role, stars, comment = '' }) => {
  await db.tx(async (c) => {
    const { rows: [job] } = await c.query('SELECT * FROM delivery_job WHERE id = $1 FOR UPDATE', [jobId]);
    const mineAsBuyer = role === 'buyer_to_partner';
    if (!job || (mineAsBuyer ? job.requester_id : job.partner_id) !== raterId) throw new HttpError(404, 'Delivery not found');
    if (job.status !== 'delivered') throw new HttpError(409, 'You can rate a delivery once it is done');
    const rateeId = mineAsBuyer ? job.partner_id : job.requester_id;
    const { rowCount } = await c.query(
      'INSERT INTO delivery_rating (job_id, role, rater_id, ratee_id, stars, comment) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (job_id, role) DO NOTHING',
      [jobId, role, raterId, rateeId, stars, comment]);
    if (!rowCount) throw new HttpError(409, 'You have already rated this delivery');
    if (mineAsBuyer) {
      await c.query(
        'UPDATE delivery_partner SET rating_avg = ROUND((rating_avg * rating_count + $2) / (rating_count + 1), 2), rating_count = rating_count + 1 WHERE user_id = $1',
        [rateeId, stars]);
    }
  });
};

// ---------------------------------------------------------------------------
// The partner's money
// ---------------------------------------------------------------------------

// What he has earned, what he owes which center, and the latest entries.
const wallet = async (q, partnerId, { limit = 50 } = {}) => {
  const { rows: [t] } = await q.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'fee_earned'), 0) AS earned,
            COALESCE(SUM(amount) FILTER (WHERE kind IN ('goods_owed','goods_settled')), 0) AS owed
       FROM delivery_ledger WHERE partner_id = $1`, [partnerId]);
  const { rows: byCenter } = await q.query(
    `SELECT l.center_id AS "centerId", COALESCE(c.name, 'Village center') AS "centerName", SUM(l.amount) AS owed
       FROM delivery_ledger l LEFT JOIN village_center c ON c.center_id = l.center_id
      WHERE l.partner_id = $1 AND l.kind IN ('goods_owed','goods_settled')
      GROUP BY l.center_id, c.name HAVING SUM(l.amount) <> 0 ORDER BY c.name`, [partnerId]);
  const { rows: entries } = await q.query(
    `SELECT id, kind, amount, note, job_id AS "jobId", center_id AS "centerId", created_at AS "createdAt"
       FROM delivery_ledger WHERE partner_id = $1 ORDER BY created_at DESC, id LIMIT $2`, [partnerId, limit]);
  const { rows: [p] } = await q.query('SELECT deliveries_done, rating_avg, rating_count, cancellations FROM delivery_partner WHERE user_id = $1', [partnerId]);
  return {
    earned: money(t.earned), owed: money(t.owed),
    owedByCenter: byCenter.map((r) => ({ ...r, owed: money(r.owed) })),
    entries: entries.map((e) => ({ ...e, amount: money(e.amount) })),
    deliveriesDone: p?.deliveries_done ?? 0, ratingAvg: p ? Number(p.rating_avg) : 0, ratingCount: p?.rating_count ?? 0, cancellations: p?.cancellations ?? 0,
  };
};

// ---------------------------------------------------------------------------
// The operator's side
// ---------------------------------------------------------------------------

const OPERATOR_SELECT = `j.id, j.kind, j.order_id AS "orderId", j.status, j.fee, j.weight_kg AS "weightKg", j.distance_km AS "distanceKm",
  j.goods_amount AS "goodsAmount", j.drop_village AS "dropVillage", j.created_at AS "createdAt", j.assigned_at AS "assignedAt",
  j.picked_up_at AS "pickedUpAt", j.delivered_at AS "deliveredAt", j.search_until AS "searchUntil", j.operator_told_at AS "needsDriverSince",
  j.partner_id AS "partnerId", COALESCE(NULLIF(pp.name, ''), NULL) AS "partnerName", dp.phone AS "partnerPhone",
  dp.vehicle_type AS "vehicleType", dp.vehicle_number AS "vehicleNumber", dp.rating_avg AS "ratingAvg",
  (SELECT count(*)::int FROM delivery_offer o WHERE o.job_id = j.id AND o.status = 'pending' AND o.expires_at > now()) AS "offersPending",
  COALESCE(NULLIF(bp.name, ''), 'Farmer') AS "buyerName"`;
const OPERATOR_FROM = `delivery_job j LEFT JOIN delivery_partner dp ON dp.user_id = j.partner_id
  LEFT JOIN profiles pp ON pp.owner_id = j.partner_id LEFT JOIN profiles bp ON bp.owner_id = j.requester_id`;

const operatorShape = (r) => ({
  ...r, fee: money(r.fee), weightKg: Number(r.weightKg), distanceKm: Number(r.distanceKm), goodsAmount: money(r.goodsAmount),
  ratingAvg: r.ratingAvg == null ? null : Number(r.ratingAvg), cashToCollect: money(r.goodsAmount) + money(r.fee),
  // Open and nobody has been found for a while: the operator can assign someone.
  needsDriver: r.status === 'open' && r.needsDriverSince != null,
});

const operatorJobView = async (q, jobId) => {
  const { rows: [r] } = await q.query(`SELECT ${OPERATOR_SELECT} FROM ${OPERATOR_FROM} WHERE j.id = $1`, [jobId]);
  return r ? operatorShape(r) : null;
};

// The operator picks a partner themself, when nobody accepted. They can also
// swap one who is not yet on the road. Range and hours are their call (they
// know the people); the load, approval and one-job-at-a-time still apply.
const assignByOperator = async (db, { jobId, centerId, partnerId, now = new Date() }) => {
  await db.tx(async (c) => {
    const { rows: [job] } = await c.query('SELECT * FROM delivery_job WHERE id = $1 FOR UPDATE', [jobId]);
    if (!job || job.center_id !== centerId) throw new HttpError(404, 'Delivery not found');
    if (!['open', 'assigned'].includes(job.status)) throw new HttpError(409, `This delivery is ${job.status === 'in_transit' ? 'already on the road' : job.status === 'delivered' ? 'already done' : 'no longer active'}`);
    if (job.partner_id === partnerId) throw new HttpError(409, 'That partner already has this job');
    const row = await partners.findRow(c, partnerId, { lock: true });
    if (!row || row.status !== 'approved') throw new HttpError(404, 'That person is not an approved delivery partner');
    if (partnerId === job.requester_id) throw new HttpError(409, 'A farmer cannot deliver their own order');
    if (row.capacityKg < Number(job.weight_kg)) throw new HttpError(409, `That vehicle carries ${row.capacityKg} kg, but this load is ${Number(job.weight_kg)} kg`);
    if ((await jobs.activeJobCount(c, partnerId)) >= jobs.D.maxActiveJobs) throw new HttpError(409, 'That partner is already on a delivery');
    if (job.status === 'assigned') {
      await c.query("UPDATE delivery_offer SET status = 'released', responded_at = $3 WHERE job_id = $1 AND partner_id = $2", [job.id, job.partner_id, now]);
      await notify(c, job.partner_id, { type: 'delivery', title: 'This delivery was given to someone else', body: 'The village center reassigned it. You do not need to go.', refId: job.id });
    }
    await jobs.assign(c, job, partners.toView(row), { by: 'operator', now });
  });
  return operatorJobView(db, jobId);
};

// Who the operator could give a job to: approved partners whose vehicle can carry
// it and who are not already busy, nearest first, with a flag for who is free
// right now. It is the operator's call to pick someone who is not.
const assignmentCandidates = async (q, { jobId, centerId, now = new Date(), timeZone }) => {
  const { rows: [job] } = await q.query('SELECT * FROM delivery_job WHERE id = $1', [jobId]);
  if (!job || job.center_id !== centerId) throw new HttpError(404, 'Delivery not found');
  const { rows } = await q.query(
    `SELECT p.user_id AS "userId", p.status, p.vehicle_type AS "vehicleType", p.vehicle_number AS "vehicleNumber", p.capacity_kg AS "capacityKg",
            p.phone, p.max_distance_km AS "maxDistanceKm", p.review_center_id AS "reviewCenterId", p.days AS "daysMask", p.online, p.rating_avg AS "ratingAvg", p.rating_count AS "ratingCount",
            to_char(p.free_from, 'HH24:MI') AS "freeFrom", to_char(p.free_until, 'HH24:MI') AS "freeUntil",
            COALESCE(NULLIF(pr.name, ''), 'Farmer') AS name,
            COALESCE(p.latitude, pr.latitude) AS latitude, COALESCE(p.longitude, pr.longitude) AS longitude
       FROM delivery_partner p LEFT JOIN profiles pr ON pr.owner_id = p.user_id
      WHERE p.status = 'approved' AND p.capacity_kg >= $1 AND p.user_id <> $2 AND p.user_id IS DISTINCT FROM $3
        AND (SELECT count(*) FROM delivery_job j WHERE j.partner_id = p.user_id AND j.status IN ('assigned','in_transit')) < $4`,
    [job.weight_kg, job.requester_id, job.partner_id, jobs.D.maxActiveJobs]);
  return rows
    .map((p) => ({ ...p, toPickupKm: p.latitude == null ? null : roadKm(haversineKm(p, { latitude: job.pickup_latitude, longitude: job.pickup_longitude })) }))
    // People this center approved, or who live within their own range of the pickup: not every partner on the map.
    .filter((p) => p.reviewCenterId === centerId || (p.toPickupKm != null && p.toPickupKm <= p.maxDistanceKm))
    .map((p) => ({
      userId: p.userId, name: p.name, phone: p.phone, vehicleType: p.vehicleType, vehicleNumber: p.vehicleNumber, capacityKg: p.capacityKg,
      ratingAvg: Number(p.ratingAvg), ratingCount: p.ratingCount,
      toPickupKm: p.toPickupKm,
      freeNow: partners.availabilityAt(p, now, timeZone).free,
    }))
    .sort((a, b) => Number(b.freeNow) - Number(a.freeNow) || (a.toPickupKm ?? 1e9) - (b.toPickupKm ?? 1e9) || (a.userId < b.userId ? -1 : 1));
};

// Cash a partner collected for goods and has not yet handed to this center.
const owedToCenter = async (q, centerId) => {
  const { rows } = await q.query(
    `SELECT l.partner_id AS "partnerId", COALESCE(NULLIF(pr.name, ''), 'Farmer') AS name, dp.phone, SUM(l.amount) AS owed
       FROM delivery_ledger l LEFT JOIN profiles pr ON pr.owner_id = l.partner_id LEFT JOIN delivery_partner dp ON dp.user_id = l.partner_id
      WHERE l.center_id = $1 AND l.kind IN ('goods_owed','goods_settled')
      GROUP BY l.partner_id, pr.name, dp.phone HAVING SUM(l.amount) > 0 ORDER BY SUM(l.amount) DESC`, [centerId]);
  return rows.map((r) => ({ ...r, owed: money(r.owed) }));
};

// The partner hands cash to the operator; the operator records how much.
const settleCash = async (db, { centerId, partnerId, amount, note = '', actorId }) => {
  await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cash:${centerId}:${partnerId}`]);
    const { rows: [{ owed }] } = await c.query(
      `SELECT COALESCE(SUM(amount), 0) AS owed FROM delivery_ledger WHERE center_id = $1 AND partner_id = $2 AND kind IN ('goods_owed','goods_settled')`, [centerId, partnerId]);
    if (money(owed) <= 0) throw new HttpError(409, 'That partner does not owe this center anything');
    if (amount > money(owed)) throw new HttpError(409, `That partner only owes Rs ${money(owed)}`);
    await ledger(c, { partnerId, centerId, kind: 'goods_settled', amount: -amount, note: note || 'Cash handed to the center', actorId });
    const left = money(owed) - amount;
    await notify(c, partnerId, {
      type: 'delivery', title: 'The center recorded your cash',
      body: left > 0 ? `Rs ${amount} recorded. You still owe Rs ${left}.` : `Rs ${amount} recorded. You owe nothing to this center.`, refId: centerId,
    });
  });
  return owedToCenter(db, centerId);
};

module.exports = {
  handover, handoverByRequester, requesterView, deliver, buyerDelivery, buyerDeliveries, buyerViewOf, switchToPickup, rate, wallet,
  OPERATOR_SELECT, OPERATOR_FROM, operatorShape, operatorJobView, assignByOperator, assignmentCandidates, owedToCenter, settleCash,
  MAX_WRONG_CODES,
};
