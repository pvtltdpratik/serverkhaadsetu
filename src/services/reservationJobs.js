const { findOrder } = require('./orders');
const { releaseOrderStock } = require('./reservations');
const { notify } = require('./notifications');

const DAY_MS = 24 * 60 * 60 * 1000;

// Day N of a reservation begins N-1 days after the order (the order day is
// day 1). A 5-day reservation therefore ends at the close of day 5; the
// reminders go out as day 3 and day 5 begin, i.e. 3 days and 1 day before the
// deadline.
const DAY_3_REMINDER_BEFORE_MS = 3 * DAY_MS;
const DAY_5_REMINDER_BEFORE_MS = 1 * DAY_MS;

const ACTIVE = "status IN ('pending','readyForPickup')";

// One pass of housekeeping, safe to run as often as you like and from several
// server instances at once (an advisory lock lets only one do the work).
//   - reservations past their deadline are cancelled and their stock released
//   - farmers get a reminder on day 3 and on day 5 of their reservation
const runReservationMaintenance = async (db, now = new Date()) => {
  return db.tx(async (c) => {
    const { rows: [lock] } = await c.query('SELECT pg_try_advisory_xact_lock(727203) AS ok');
    if (!lock.ok) return { skipped: true, expired: 0, reminded: 0 };

    // ---- expire ----
    const { rows: due } = await c.query(
      `SELECT id FROM orders WHERE stock_reserved AND ${ACTIVE} AND reserved_until <= $1 ORDER BY reserved_until FOR UPDATE SKIP LOCKED`,
      [now],
    );
    let expired = 0;
    for (const { id } of due) {
      const order = await findOrder(c, id, { lock: true });
      if (!order.stockReserved || (order.status !== 'pending' && order.status !== 'readyForPickup')) continue;
      await releaseOrderStock(c, order);
      await c.query("UPDATE orders SET status = 'cancelled', pickup_otp = NULL WHERE id = $1", [id]);
      await notify(c, order.ownerId, {
        type: 'order',
        title: 'Your reservation expired',
        body: 'You did not collect this order in time, so the items were released. You can place a new order any time.',
        refId: id,
      });
      const operator = (await c.query('SELECT operator_id FROM village_center WHERE center_id = $1', [order.centerId])).rows[0];
      if (operator) {
        await notify(c, operator.operator_id, {
          type: 'order',
          title: 'Reservation expired',
          body: `${order.customerName} did not collect their order; the stock is back on your shelf.`,
          refId: id,
        });
      }
      expired += 1;
    }

    // ---- remind ----
    const { rows: soon } = await c.query(
      `SELECT id, owner_id, reserved_until, reminder_stage FROM orders
        WHERE stock_reserved AND ${ACTIVE} AND reserved_until > $1 AND reminder_stage < 2 AND owner_id IS NOT NULL
        FOR UPDATE SKIP LOCKED`,
      [now],
    );
    let reminded = 0;
    for (const o of soon) {
      const untilDeadline = new Date(o.reserved_until).getTime() - now.getTime();
      // If the job was down, jump straight to the latest reminder that is due.
      const stage = untilDeadline <= DAY_5_REMINDER_BEFORE_MS ? 2 : untilDeadline <= DAY_3_REMINDER_BEFORE_MS ? 1 : 0;
      if (stage <= o.reminder_stage) continue;
      await c.query('UPDATE orders SET reminder_stage = $2 WHERE id = $1', [o.id, stage]);
      await notify(c, o.owner_id, {
        type: 'order',
        title: stage === 2 ? 'Last day to collect your order' : 'Your order is waiting for you',
        body: stage === 2
          ? 'Your reservation ends today. Collect your order from the village center or the items will be released.'
          : `Your items are reserved until ${new Date(o.reserved_until).toDateString()}. Please collect them from the village center.`,
        refId: o.id,
      });
      reminded += 1;
    }
    return { skipped: false, expired, reminded };
  });
};

module.exports = { runReservationMaintenance };
