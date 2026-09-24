const crypto = require('crypto');
const { HttpError } = require('../utils/http');
const config = require('../config');
const { notify } = require('./notifications');
const { haversineKm, boundingBox } = require('./geo');
const { roadKm, computeFee, suggestVehicle, etaMinutes } = require('./deliveryFee');
const partners = require('./deliveryPartner');
const { SERVICEABLE } = require('./centerService');
const trips = require('./deliveryTrips');

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

// What carrying `weightKg` from one place to another costs, or that it is too far.
const priceRoute = ({ from, to, weightKg }) => {
  const km = roadKm(haversineKm(from, to));
  const tooFar = km > D.maxRoadKm;
  return {
    weightKg, roadKm: km, tooFar, maxRoadKm: D.maxRoadKm,
    fee: tooFar ? null : computeFee({ roadKm: km, weightKg }),
    suggestedVehicle: suggestVehicle(weightKg),
  };
};

// What delivering `items` from `center` to `drop` costs, or why it cannot be done.
const priceDelivery = async (q, { center, items, drop }) => ({
  centerId: center.centerId,
  ...priceRoute({ from: center, to: drop, weightKg: await weightOf(q, items) }),
});

// ---------------------------------------------------------------------------
// Who can take a job
// ---------------------------------------------------------------------------

// What he is already carrying (assigned or on the road), in kg.
const carriedKg = async (q, partnerId) => Number((await q.query(
  "SELECT COALESCE(SUM(weight_kg), 0) AS kg FROM delivery_job WHERE partner_id = $1 AND status IN ('assigned','in_transit')", [partnerId])).rows[0].kg);

// Approved partners who can take this job, best first:
//  1. those with a trip today along this road (they are going that way anyway),
//  2. those who already have a not-yet-collected job going the same way (a batch),
//  3. then the nearest free ones, and the better rated.
// A partner qualifies when his vehicle carries this load ON TOP of what he already
// has, he is free now and willing to go this far, and he is not too busy.
// `job` needs {weightKg, requesterId, pickup, roadKm}; add `drop` for batching and
// trips. `jobId` (if any) excludes partners who already had an offer for it.
const eligiblePartners = async (q, { job, jobId = null, now, timeZone }) => {
  const { rows } = await q.query(
    `SELECT p.user_id AS "userId", p.status, p.vehicle_type AS "vehicleType", p.capacity_kg AS "capacityKg",
            p.max_distance_km AS "maxDistanceKm", p.days AS "daysMask",
            to_char(p.free_from, 'HH24:MI') AS "freeFrom", to_char(p.free_until, 'HH24:MI') AS "freeUntil",
            p.online, p.rating_avg AS "ratingAvg",
            COALESCE(p.latitude, pr.latitude) AS latitude, COALESCE(p.longitude, pr.longitude) AS longitude,
            COALESCE((SELECT SUM(j.weight_kg) FROM delivery_job j WHERE j.partner_id = p.user_id AND j.status IN ('assigned','in_transit')), 0) AS "carryingKg",
            (SELECT count(*)::int FROM delivery_job j WHERE j.partner_id = p.user_id AND j.status IN ('assigned','in_transit')) AS "activeJobs"
       FROM delivery_partner p LEFT JOIN profiles pr ON pr.owner_id = p.user_id
      WHERE p.status = 'approved' AND p.user_id <> $1
        AND ($2::text IS NULL OR NOT EXISTS (SELECT 1 FROM delivery_offer o WHERE o.job_id = $2 AND o.partner_id = p.user_id AND o.status <> 'closed'))`,
    [job.requesterId, jobId],
  );
  const fits = (p) => p.activeJobs < D.maxActiveJobs && p.capacityKg - Number(p.carryingKg) >= job.weightKg;

  // Jobs he has taken but not yet collected: a new one going the same way can ride along.
  const assigned = job.drop && rows.length
    ? (await q.query(
      `SELECT partner_id AS "partnerId", pickup_latitude AS "pl", pickup_longitude AS "pn", drop_latitude AS "dl", drop_longitude AS "dn"
         FROM delivery_job WHERE status = 'assigned' AND partner_id = ANY($1)`, [rows.map((r) => r.userId)])).rows
    : [];
  const rides = (p) => assigned.some((a) => a.partnerId === p.userId
    && haversineKm({ latitude: a.pl, longitude: a.pn }, job.pickup) <= D.batchKm
    && haversineKm({ latitude: a.dl, longitude: a.dn }, job.drop) <= D.batchKm);

  const tripUsers = new Set((await trips.tripPartnersFor(q, { job, now, timeZone })).map((t) => t.userId));

  return rows
    .filter((p) => fits(p) && p.latitude != null)
    .map((p) => ({
      ...p, toPickupKm: roadKm(haversineKm(p, job.pickup)), ratingAvg: Number(p.ratingAvg),
      onTrip: tripUsers.has(p.userId), batch: rides(p),
    }))
    .filter((p) => p.onTrip || (
      partners.availabilityAt({ ...p, daysMask: p.daysMask }, now, timeZone).free
      && p.toPickupKm <= p.maxDistanceKm && job.roadKm <= p.maxDistanceKm))
    .sort((a, b) => Number(b.onTrip) - Number(a.onTrip) || Number(b.batch) - Number(a.batch)
      || a.toPickupKm - b.toPickupKm || b.ratingAvg - a.ratingAvg || (a.userId < b.userId ? -1 : 1));
};

const jobSpec = (row) => ({
  weightKg: Number(row.weight_kg), requesterId: row.requester_id, roadKm: Number(row.distance_km),
  pickup: { latitude: row.pickup_latitude, longitude: row.pickup_longitude },
  drop: { latitude: row.drop_latitude, longitude: row.drop_longitude },
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

  // Booked onto someone's trip: he is asked first, and the offer waits for him
  // (until the search ends). Only if he turns it down does the general pool see it.
  if (job.trip_id) {
    const { rows: [t] } = await c.query("SELECT partner_id FROM delivery_trip WHERE id = $1 AND status = 'open'", [job.trip_id]);
    const { rowCount: asked } = t
      ? await c.query("SELECT 1 FROM delivery_offer WHERE job_id = $1 AND partner_id = $2 AND status <> 'closed'", [job.id, t.partner_id])
      : { rowCount: 1 };
    if (t && !asked) {
      await c.query(
        'INSERT INTO delivery_offer (job_id, partner_id, round, offered_at, expires_at) VALUES ($1,$2,1,$3,$4)',
        [job.id, t.partner_id, now, job.search_until]);
      await c.query('UPDATE delivery_job SET rounds = 1 WHERE id = $1', [job.id]);
      await notify(c, t.partner_id, {
        type: 'delivery', title: `Someone booked room on your trip: Rs ${money(job.fee)}`,
        body: `${Number(job.weight_kg)} kg from ${job.pickup_label || 'a farm'} to ${job.drop_village || job.drop_label || 'a farm'}. Open the app to accept.`, refId: job.id,
      });
      return { offered: 1 };
    }
  }

  const candidates = (await eligiblePartners(c, { job: jobSpec(job), jobId: job.id, now, timeZone })).slice(0, D.offersPerRound);
  if (!candidates.length) {
    // Nobody free right now. Keep looking until the deadline, but ask the operator
    // to step in once so a person can phone around.
    if (!job.operator_told_at) {
      await c.query('UPDATE delivery_job SET operator_told_at = $2 WHERE id = $1', [job.id, now]);
      // A farmer-to-farmer job has no center: the sender is the one to hear it.
      if (!job.center_id) {
        await notify(c, job.requester_id, {
          type: 'delivery', title: 'No delivery partner is free yet',
          body: 'We are still looking. If nobody is found in time we will tell you.', refId: job.id,
        });
      }
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
      body: `${Number(job.weight_kg)} kg from ${job.pickup_label || 'a farm'} to ${job.drop_village || 'a farm'}, ${Number(job.distance_km)} km. ${p.toPickupKm} km to the pickup.${p.batch ? ' It goes the same way as a job you already have.' : ''}${p.onTrip ? ' It is along your trip today.' : ''} Open the app to accept.`,
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
  else {
    await notify(c, job.requester_id, {
      type: 'delivery', title: 'No delivery partner was free',
      body: 'Nobody could carry your load in time. You can ask again, or look at the trips other farmers have posted.', refId: job.id,
    });
  }
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
  const p2p = job.kind === 'p2p';
  await notify(c, job.requester_id, p2p ? {
    type: 'delivery', title: 'A delivery partner is coming to collect your load',
    body: `${partnerLine(partnerRow)} will pick it up. Ask for their handover code before you give it, and keep your delivery code for the receiver.`, refId: job.id,
  } : {
    type: 'delivery', title: 'A delivery partner is on the way to the center',
    body: `${partnerLine(partnerRow)} will bring your order. Keep your delivery code ready.`, refId: job.order_id,
  });
  await tellOperator(c, job.center_id, {
    title: 'A delivery partner is coming for an order',
    body: `${partnerLine(partnerRow)} will collect it. Check their handover code before you give the goods.`, refId: job.order_id,
  });
  await offerAlong(c, partnerRow, job, now);
  if (by === 'operator') {
    await notify(c, partnerRow.userId, {
      type: 'delivery', title: 'You were given a delivery job',
      body: `The village center assigned you ${Number(job.weight_kg)} kg from ${job.pickup_label} to ${job.drop_village || 'a farm'}. Rs ${money(job.fee)}.`, refId: job.id,
    });
  }
};

// He has taken a job: other open jobs that go the same way, and still fit in the
// vehicle, are offered to him too, so one trip can serve several farms.
const offerAlong = async (c, partnerRow, taken, now) => {
  if ((await activeJobCount(c, partnerRow.userId)) >= D.maxActiveJobs) return;
  const room = partnerRow.capacityKg - (await carriedKg(c, partnerRow.userId));
  if (room <= 0) return;
  const { rows } = await c.query(
    `SELECT * FROM delivery_job j WHERE j.status = 'open' AND j.id <> $1 AND j.trip_id IS NULL AND j.requester_id <> $2
        AND j.weight_kg <= $3 AND j.search_until > $4
        AND NOT EXISTS (SELECT 1 FROM delivery_offer o WHERE o.job_id = j.id AND o.partner_id = $2 AND o.status <> 'closed')
      ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED`, [taken.id, partnerRow.userId, room, now]);
  const here = { latitude: taken.pickup_latitude, longitude: taken.pickup_longitude };
  const there = { latitude: taken.drop_latitude, longitude: taken.drop_longitude };
  const along = rows.filter((j) =>
    haversineKm(here, { latitude: j.pickup_latitude, longitude: j.pickup_longitude }) <= D.batchKm
    && haversineKm(there, { latitude: j.drop_latitude, longitude: j.drop_longitude }) <= D.batchKm).slice(0, 2);
  for (const j of along) {
    await c.query(
      `INSERT INTO delivery_offer (job_id, partner_id, round, offered_at, expires_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (job_id, partner_id) DO UPDATE SET status = 'pending', round = EXCLUDED.round, offered_at = EXCLUDED.offered_at,
         expires_at = EXCLUDED.expires_at, responded_at = NULL`,
      [j.id, partnerRow.userId, j.rounds + 1, now, new Date(now.getTime() + D.offerMinutes * MIN)]);
    await c.query('UPDATE delivery_job SET rounds = rounds + 1 WHERE id = $1', [j.id]);
    await notify(c, partnerRow.userId, {
      type: 'delivery', title: `Take one more on the same trip: Rs ${money(j.fee)}`,
      body: `${Number(j.weight_kg)} kg from the same place to ${j.drop_village || 'a farm nearby'}. You have room for it. Open the app to add it.`, refId: j.id,
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
    const carrying = await carriedKg(c, partnerId);
    if (row.capacityKg - carrying < Number(job.weight_kg)) {
      throw new HttpError(409, `Your vehicle carries ${row.capacityKg} kg and you already have ${carrying} kg to deliver, so this ${Number(job.weight_kg)} kg load does not fit`);
    }
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
    items: row.kind === 'p2p' ? row.description : await itemsSummary(q, row.order_id),
    feePayer: row.fee_payer,
    tripId: row.trip_id,
    pickup: { label: row.pickup_label, centerName: row.center_name, village: row.center_village, latitude: row.pickup_latitude, longitude: row.pickup_longitude },
    drop: { village: row.drop_village },
    mine: own,
  };
  if (row.offer_expires_at) view.offerExpiresAt = row.offer_expires_at;
  if (own && ['assigned', 'in_transit', 'delivered'].includes(row.status)) {
    view.drop = { village: row.drop_village, label: row.drop_label, latitude: row.drop_latitude, longitude: row.drop_longitude, phone: row.drop_phone, note: row.drop_note };
    view.buyerName = row.buyer_name;
    if (row.kind === 'p2p') view.pickup = { ...view.pickup, phone: row.pickup_phone, note: '' };
    // The code he reads to the operator to get the goods; only he ever sees it.
    view.handoverCode = row.status === 'assigned' ? row.pickup_otp : null;
    // What he collects from the buyer in cash, and what of it is his.
    view.cashToCollect = money(row.goods_amount) + money(row.fee);
    // Who hands him the fee: the buyer at the drop, or (farmer-to-farmer) whoever agreed to pay it.
    view.collectFeeFrom = row.kind === 'p2p' ? row.fee_payer : 'receiver';
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
  D, priceRoute, carriedKg, offerAlong, newOtp, closeJob, cancelJobForOrder, weightOf, priceDelivery, eligiblePartners, jobSpec, createForOrder, dispatchRound, fallback, backToPickup,
  runDeliveryDispatch, accept, decline, assign, activeJobCount, offersFor, activeFor, jobForPartner, centerOf, tellOperator,
  JOB_SELECT, JOB_FROM, partnerJobView,
};
