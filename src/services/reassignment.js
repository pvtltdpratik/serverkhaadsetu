const { findOrder } = require('./orders');
const { findNearby } = require('./nearbyCenters');
const { tryReserve, releaseOrderStock } = require('./reservations');
const { checkLowStock } = require('./stockAlerts');
const { hoursStatus } = require('./centerRanking');
const { notify } = require('./notifications');

// A center that cannot serve its waiting orders must not strand them. Every so
// often this looks for orders still awaiting the operator ("pending", not yet
// marked ready) at a center that cannot serve them right now, and moves each to
// the next-best center that has EVERYTHING, taking the reserved stock with it.

const GRACE_MINUTES = 30; // a brief break (lunch, a short trip) should not shuffle orders
const OFFLINE_HOURS = 12; // silence this long, during opening hours, means offline
const MAX_REASSIGNMENTS = 2;

const REASONS = {
  closed: 'has been closed by its operator',
  suspended: 'is not taking orders at the moment',
  offline: 'has not been reachable',
};

// Why a center cannot serve, or null if it can.
const unavailability = (c, now, timeZone) => {
  if (c.status !== 'active' || !c.operatorId || c.operatorSuspended) return 'suspended';
  if (!c.isOpen) return 'closed';
  const quiet = now.getTime() - new Date(c.lastActiveAt).getTime() >= OFFLINE_HOURS * 3600 * 1000;
  // Being quiet overnight is normal; only silence during opening hours counts.
  if (quiet && hoursStatus({ isOpen: true, opensAt: c.opensAt, closesAt: c.closesAt }, now, timeZone).isOpenNow) return 'offline';
  return null;
};

const runReassignment = async (db, { now = new Date(), timeZone = 'Asia/Kolkata', graceMinutes = GRACE_MINUTES } = {}) => {
  return db.tx(async (c) => {
    const { rows: [lock] } = await c.query('SELECT pg_try_advisory_xact_lock(727204) AS ok');
    if (!lock.ok) return { skipped: true, moved: 0, stuck: 0 };

    // Candidates: waiting orders, past the grace period, whose center is not
    // plainly fine. (The offline rule needs opening hours, so it is finished in JS.)
    const { rows } = await c.query(
      `SELECT o.id, o.origin_latitude AS "originLat", o.origin_longitude AS "originLng", o.owner_id AS "ownerId",
              ce.center_id AS "centerId", ce.name AS "centerName", ce.status, ce.operator_id AS "operatorId", ce.is_open AS "isOpen",
              to_char(ce.opens_at, 'HH24:MI') AS "opensAt", to_char(ce.closes_at, 'HH24:MI') AS "closesAt",
              ce.last_active_at AS "lastActiveAt", ce.latitude AS "centerLat", ce.longitude AS "centerLng",
              EXISTS (SELECT 1 FROM app_user u WHERE u.user_id = ce.operator_id AND u.status = 'suspended') AS "operatorSuspended"
         FROM orders o JOIN village_center ce ON ce.center_id = o.center_id
        WHERE o.type = 'appOrder' AND o.status = 'pending' AND o.stock_reserved
          AND o.reassign_count < $1 AND o.created_at <= $2
          -- Surplus units exist only at the center that listed them, so such an order cannot move.
          AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.surplus_lot_id IS NOT NULL)
          AND (ce.is_open = false OR ce.status <> 'active' OR ce.operator_id IS NULL
               OR ce.last_active_at <= $3
               OR EXISTS (SELECT 1 FROM app_user u WHERE u.user_id = ce.operator_id AND u.status = 'suspended'))
        ORDER BY o.created_at
          FOR UPDATE OF o SKIP LOCKED`,
      [MAX_REASSIGNMENTS, new Date(now.getTime() - graceMinutes * 60000), new Date(now.getTime() - OFFLINE_HOURS * 3600 * 1000)],
    );

    let moved = 0;
    let stuck = 0;
    for (const cand of rows) {
      const why = unavailability(cand, now, timeZone);
      if (!why) continue;

      const order = await findOrder(c, cand.id, { lock: true });
      if (!order.stockReserved || order.status !== 'pending') continue;
      const items = order.items.filter((i) => i.productId).map((i) => ({ productId: i.productId, quantity: i.quantity }));
      if (!items.length) continue;

      // Rank from where the farmer was; if that was not recorded, from the old
      // center (the best available guess at "near them").
      const origin = cand.originLat != null
        ? { latitude: cand.originLat, longitude: cand.originLng }
        : { latitude: cand.centerLat, longitude: cand.centerLng };
      const { centers: ranked } = await findNearby(c, { origin, items, limit: 10, timeZone, now });
      const options = ranked.filter((r) => r.center.centerId !== cand.centerId && r.inventory.status === 'all' && r.hours.isSwitchedOn);

      let target = null;
      for (const option of options) {
        if (await tryReserve(c, option.center.centerId, items)) {
          target = option;
          break;
        }
      }
      if (!target) {
        stuck += 1;
        continue;
      }

      await releaseOrderStock(c, order); // back on the old shelf (and clears its low-stock state)
      await c.query(
        `UPDATE orders SET center_id = $2, stock_reserved = true, reassign_count = reassign_count + 1, reassigned_at = $3 WHERE id = $1`,
        [order.id, target.center.centerId, now],
      );
      await checkLowStock(c, target.center.centerId, items.map((i) => i.productId));

      const newOperator = (await c.query('SELECT operator_id FROM village_center WHERE center_id = $1', [target.center.centerId])).rows[0];
      await notify(c, cand.ownerId, {
        type: 'order',
        title: 'Your order was moved to another center',
        body: `${cand.centerName} ${REASONS[why]}, so your order is now at ${target.center.name}, ${target.center.village} (${target.distanceKm} km away). Your pickup code is unchanged.`,
        refId: order.id,
      });
      if (cand.operatorId) {
        await notify(c, cand.operatorId, {
          type: 'order',
          title: 'An order was moved away from your center',
          body: `${order.customerName}'s order was moved to ${target.center.name} because your center ${REASONS[why]}.`,
          refId: order.id,
        });
      }
      if (newOperator?.operator_id) {
        await notify(c, newOperator.operator_id, {
          type: 'order',
          title: 'New app order (moved to you)',
          body: `${order.customerName}: ${order.items.map((i) => `${i.quantity} x ${i.productName}`).join(', ')}. It was moved from ${cand.centerName}. Set it aside for pickup.`,
          refId: order.id,
        });
      }
      moved += 1;
    }
    return { skipped: false, moved, stuck };
  });
};

module.exports = { runReassignment, unavailability, GRACE_MINUTES, OFFLINE_HOURS, MAX_REASSIGNMENTS };
