const { HttpError } = require('../utils/http');
const { LOT_LIVE } = require('./surplus');

// ---- People, categorised ------------------------------------------------
//
// Every signed-in person is one of two roles and sits in one segment:
//   role     'operator' - owns a village center, or asked to be one at sign-up
//            'farmer'   - everyone else
//   segment  'active'     - in good standing
//            'suspended'  - the account is suspended (for an operator, so is a
//                           suspended center)
//            'unassigned' - an operator who has no center yet
// Administrators are not listed: they are managed in configuration, not here.
const USER_ROWS = `
  SELECT u.user_id AS "userId", u.email, u.name, u.status, u.requested_role AS "requestedRole",
         CASE WHEN c.center_id IS NOT NULL OR u.requested_role = 'operator' THEN 'operator' ELSE 'farmer' END AS role,
         CASE
           WHEN u.status = 'suspended' THEN 'suspended'
           WHEN c.center_id IS NOT NULL AND c.status = 'suspended' THEN 'suspended'
           WHEN c.center_id IS NULL AND u.requested_role = 'operator' THEN 'unassigned'
           ELSE 'active'
         END AS segment,
         c.center_id AS "centerId", c.name AS "centerName", c.status AS "centerStatus",
         p.village, p.land_holding_hectares AS "landHoldingHectares",
         (SELECT count(*)::int FROM orders o WHERE o.owner_id = u.user_id) AS "ordersCount",
         u.created_at AS "createdAt", u.last_seen_at AS "lastSeenAt"
    FROM app_user u
    LEFT JOIN village_center c ON c.operator_id = u.user_id
    LEFT JOIN profiles p ON p.owner_id = u.user_id
   WHERE lower(u.email) <> ALL($1::text[])`;

const SEGMENTS = ['active', 'suspended', 'unassigned'];
const ROLES = ['operator', 'farmer'];

// The same classification as USER_ROWS, counted in one pass.
const userSummary = async (db, adminEmails) => {
  const { rows } = await db.query(
    `SELECT role, segment, count(*)::int AS n FROM (${USER_ROWS}) t GROUP BY role, segment`, [adminEmails],
  );
  const n = (role, segment) => rows.find((r) => r.role === role && r.segment === segment)?.n || 0;
  const operators = { active: n('operator', 'active'), suspended: n('operator', 'suspended'), unassigned: n('operator', 'unassigned') };
  const farmers = { active: n('farmer', 'active'), suspended: n('farmer', 'suspended') };
  return {
    operators: { ...operators, total: operators.active + operators.suspended + operators.unassigned },
    farmers: { ...farmers, total: farmers.active + farmers.suspended },
  };
};

const overview = async (db, adminEmails, now = new Date()) => {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [people, centers, orders, restock, lowStock, unattended, discrepancies, surplusStats, deliveryJobs, deliveryPartners, deliveryCash] = await Promise.all([
    userSummary(db, adminEmails),
    db.one(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
              count(*) FILTER (WHERE operator_id IS NULL)::int AS "withoutOperator",
              count(*)::int AS total
         FROM village_center`),
    db.one(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE status = 'readyForPickup')::int AS "readyForPickup",
              count(*) FILTER (WHERE created_at >= $1)::int AS today
         FROM orders`, [startOfDay]),
    db.one("SELECT count(*)::int AS pending FROM restock_requests WHERE status = 'pending'"),
    db.one('SELECT count(*)::int AS n FROM center_inventory WHERE on_hand - reserved <= reorder_level'),
    // Still low a full day after the operator was told: nobody has acted.
    db.one(`SELECT count(*)::int AS n FROM center_inventory
             WHERE on_hand - reserved <= reorder_level AND low_stock_alerted_at <= $1`, [new Date(now.getTime() - 24 * 60 * 60 * 1000)]),
    db.one("SELECT count(*)::int AS n FROM stock_discrepancy WHERE status = 'open'"),
    // Lots on sale right now, and the units left in them.
    db.one(`SELECT count(*)::int AS "activeLots", COALESCE(sum(l.quantity - l.reserved), 0)::int AS units
              FROM surplus_lot l WHERE ${LOT_LIVE}`),
    // Home delivery: jobs looking for a driver, on the road, done today.
    db.one(
      `SELECT count(*) FILTER (WHERE status = 'open')::int AS waiting,
              count(*) FILTER (WHERE status = 'open' AND operator_told_at IS NOT NULL)::int AS "needDriver",
              count(*) FILTER (WHERE status IN ('assigned','in_transit'))::int AS "onTheRoad",
              count(*) FILTER (WHERE status = 'delivered' AND delivered_at >= $1)::int AS "deliveredToday"
         FROM delivery_job`, [startOfDay]),
    db.one(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE status = 'approved')::int AS approved,
              count(*) FILTER (WHERE status = 'approved' AND online)::int AS online
         FROM delivery_partner`),
    // Cash partners collected for goods and have not yet handed to a center.
    db.one("SELECT COALESCE(SUM(amount), 0)::float AS owed FROM delivery_ledger WHERE kind IN ('goods_owed','goods_settled')"),
  ]);
  return {
    people, centers, orders, restockRequests: restock,
    lowStockItems: lowStock.n, lowStockUnattended: unattended.n, discrepanciesOpen: discrepancies.n,
    surplus: surplusStats,
    delivery: { jobs: deliveryJobs, partners: deliveryPartners, cashOwed: deliveryCash.owed },
  };
};

const findUserRow = async (db, userId, adminEmails) => {
  const { rows } = await db.query(`SELECT * FROM (${USER_ROWS}) t WHERE t."userId" = $2`, [adminEmails, userId]);
  if (!rows.length) throw new HttpError(404, 'User not found');
  return rows[0];
};

// Everything the admin needs to judge one person.
const userDetail = async (db, userId, adminEmails) => {
  const user = await findUserRow(db, userId, adminEmails);
  const profile = (await db.query(
    `SELECT latitude, longitude, location_source AS "locationSource", home_center_id AS "homeCenterId" FROM profiles WHERE owner_id = $1`, [userId])).rows[0]
    || { latitude: null, longitude: null, locationSource: null, homeCenterId: null };
  const orders = await db.rows("SELECT status, count(*)::int AS n FROM orders WHERE owner_id = $1 GROUP BY status", [userId]);
  const scans = (await db.one('SELECT count(*)::int AS n FROM scans WHERE owner_id = $1', [userId])).n;
  return {
    ...user,
    profile,
    activity: { scans, orders: Object.fromEntries(orders.map((o) => [o.status, o.n])) },
  };
};

// ---- Restock requests ---------------------------------------------------
//
// pending -> approved: the platform will supply it, so the amount is now
//                      "incoming" at that center.
// approved -> fulfilled: delivered. (The stock itself is added when the
//                      operator confirms receipt, which also clears incoming.)
const RESTOCK_FLOW = { pending: 'approved', approved: 'fulfilled' };

const advanceRestock = async (db, requestId, to, onAdvance) => {
  return db.tx(async (c) => {
    const { rows } = await c.query(
      'SELECT id, center_id, product_id, requested_quantity, status FROM restock_requests WHERE id = $1 FOR UPDATE', [requestId]);
    if (!rows.length) throw new HttpError(404, 'Restock request not found');
    const r = rows[0];
    if (RESTOCK_FLOW[r.status] !== to) {
      throw new HttpError(409, `A ${r.status} request cannot be marked ${to}` + (RESTOCK_FLOW[r.status] ? ` (next step is ${RESTOCK_FLOW[r.status]})` : ''));
    }
    await c.query('UPDATE restock_requests SET status = $2 WHERE id = $1', [requestId, to]);
    if (to === 'approved') {
      await c.query(
        `INSERT INTO center_inventory (center_id, product_id, incoming) VALUES ($1,$2,$3)
         ON CONFLICT (center_id, product_id) DO UPDATE SET incoming = center_inventory.incoming + EXCLUDED.incoming`,
        [r.center_id, r.product_id, r.requested_quantity],
      );
    }
    if (onAdvance) await onAdvance(c, r);
    return r;
  });
};

module.exports = { USER_ROWS, SEGMENTS, ROLES, userSummary, overview, findUserRow, userDetail, advanceRestock };
