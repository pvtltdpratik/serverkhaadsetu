const crypto = require('crypto');
const { HttpError } = require('../utils/http');

const CENTER_COLUMNS = `c.center_id AS "centerId", c.name, c.village, c.district, c.latitude, c.longitude,
  c.operator_id AS "operatorId", c.operator_name AS "operatorName", c.phone, c.is_open AS "isOpen",
  to_char(c.opens_at, 'HH24:MI') AS "opensAt", to_char(c.closes_at, 'HH24:MI') AS "closesAt",
  c.status, c.created_at AS "createdAt"`;

// Compatible with the operator app's existing inventory shape (`id`, `unit`,
// `unitPrice`, `currentStock`, `lowStockThreshold`, `isLowStock`), plus the
// per-center fields. `id` is the product id.
const inventoryColumns =`p.id, p.name, p.unit_label AS "unit", p.price_in_rupees AS "unitPrice",
  ci.on_hand AS "currentStock", ci.reorder_level AS "lowStockThreshold",
  (ci.on_hand - ci.reserved <= ci.reorder_level) AS "isLowStock",
  ci.reserved, (ci.on_hand - ci.reserved) AS available, ci.max_capacity AS "maxCapacity",
  ci.incoming, ci.last_restocked_at AS "lastRestockedAt"`;
const INVENTORY_FROM = 'center_inventory ci JOIN products p ON p.id = ci.product_id';

// A center can serve farmers only if it is active, has an operator, and that
// operator's account is not suspended. `c` is the village_center alias.
const SERVICEABLE = `c.status = 'active' AND c.operator_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM app_user su WHERE su.user_id = c.operator_id AND su.status = 'suspended')`;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Runs `fn` in a transaction: opens one on the pool, or simply joins the one
// the caller already has (a transaction client), so the audit log entry can
// commit or roll back together with the change.
const inTx = (q, fn) => (typeof q.tx === 'function' ? q.tx(fn) : fn(q));

const newCenterId = () => `center-${crypto.randomUUID()}`;

const findCenter = async (q, id) => {
  const { rows } = await q.query(`SELECT ${CENTER_COLUMNS} FROM village_center c WHERE c.center_id = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'Village center not found');
  return rows[0];
};

// Postgres reports "one operator, one center" as a unique violation.
const asOperatorConflict = (err) => {
  if (err && err.code === '23505') throw new HttpError(409, 'That user already operates another village center');
  throw err;
};

const assertUserExists = async (q, userId) => {
  const { rows } = await q.query('SELECT 1 FROM app_user WHERE user_id = $1', [userId]);
  if (!rows.length) throw new HttpError(404, 'That user has not signed in to the app yet');
};

const createCenter = async (db, input) => {
  const id = newCenterId();
  try {
    await inTx(db, async (c) => {
      if (input.operatorId) await assertUserExists(c, input.operatorId);
      await c.query(
        `INSERT INTO village_center (center_id, name, village, district, latitude, longitude, operator_id, operator_name, phone, opens_at, closes_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, input.name, input.village, input.district, input.latitude, input.longitude,
          input.operatorId || null, input.operatorName, input.phone, input.opensAt, input.closesAt],
      );
    });
  } catch (err) {
    asOperatorConflict(err);
  }
  return findCenter(db, id);
};

// Column per API field. Only the fields present in `changes` are written.
const UPDATABLE = {
  name: 'name', village: 'village', district: 'district', latitude: 'latitude', longitude: 'longitude',
  operatorName: 'operator_name', phone: 'phone', isOpen: 'is_open', opensAt: 'opens_at', closesAt: 'closes_at', status: 'status',
};

const updateCenter = async (db, id, changes) => {
  const sets = [];
  const params = [id];
  for (const [field, column] of Object.entries(UPDATABLE)) {
    if (changes[field] === undefined) continue;
    params.push(changes[field]);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  const { rowCount } = await db.query(`UPDATE village_center SET ${sets.join(', ')} WHERE center_id = $1`, params);
  if (!rowCount) throw new HttpError(404, 'Village center not found');
  return findCenter(db, id);
};

// `userId` null unassigns the center's operator.
const assignOperator = async (db, centerId, userId) => {
  try {
    await inTx(db, async (c) => {
      await findCenter(c, centerId);
      if (userId) await assertUserExists(c, userId);
      await c.query('UPDATE village_center SET operator_id = $2 WHERE center_id = $1', [centerId, userId || null]);
    });
  } catch (err) {
    asOperatorConflict(err);
  }
  return findCenter(db, centerId);
};

// Records who signed in. `requested_role` follows what they last chose;
// admin-controlled fields (status) are left alone.
const upsertUser = async (db, { userId, email, name, requestedRole }) => {
  const { rows } = await db.query(
    `INSERT INTO app_user (user_id, email, name, requested_role) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET
       email = COALESCE(NULLIF(EXCLUDED.email, ''), app_user.email),
       name = COALESCE(NULLIF(EXCLUDED.name, ''), app_user.name),
       requested_role = EXCLUDED.requested_role,
       last_seen_at = now()
     RETURNING user_id AS "userId", email, name, requested_role AS "requestedRole", status`,
    [userId, email, name, requestedRole],
  );
  return rows[0];
};

// Adds stock to a center's shelf (creating the row the first time). A single
// statement, so concurrent receipts add up exactly. Arriving stock also
// clears the same amount from "incoming".
const receiveStock = async (db, { centerId, productId, quantity }) => {
  const product = (await db.query('SELECT 1 FROM products WHERE id = $1', [productId])).rows.length;
  if (!product) throw new HttpError(404, 'Product not found');
  try {
    await db.query(
      `INSERT INTO center_inventory (center_id, product_id, on_hand, last_restocked_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (center_id, product_id) DO UPDATE SET
         on_hand = center_inventory.on_hand + EXCLUDED.on_hand,
         incoming = GREATEST(center_inventory.incoming - EXCLUDED.on_hand, 0),
         last_restocked_at = now()`,
      [centerId, productId, quantity],
    );
  } catch (err) {
    if (err.code === '23514') throw new HttpError(409, 'That would exceed this center\'s storage capacity for the product');
    throw err;
  }
  return inventoryItem(db, centerId, productId);
};

const inventoryItem = async (q, centerId, productId) => {
  const { rows } = await q.query(
    `SELECT ${inventoryColumns} FROM ${INVENTORY_FROM} WHERE ci.center_id = $1 AND ci.product_id = $2`,
    [centerId, productId],
  );
  if (!rows.length) throw new HttpError(404, 'This center does not stock that product');
  return rows[0];
};

const updateInventorySettings = async (db, { centerId, productId, reorderLevel, maxCapacity }) => {
  const sets = [];
  const params = [centerId, productId];
  if (reorderLevel !== undefined) { params.push(reorderLevel); sets.push(`reorder_level = $${params.length}`); }
  if (maxCapacity !== undefined) { params.push(maxCapacity); sets.push(`max_capacity = $${params.length}`); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  try {
    const { rowCount } = await db.query(
      `UPDATE center_inventory SET ${sets.join(', ')} WHERE center_id = $1 AND product_id = $2`, params);
    if (!rowCount) throw new HttpError(404, 'This center does not stock that product');
  } catch (err) {
    if (err.code === '23514') throw new HttpError(409, 'Capacity cannot be lower than the stock currently on hand');
    throw err;
  }
  return inventoryItem(db, centerId, productId);
};

module.exports = {
  CENTER_COLUMNS, INVENTORY_COLUMNS: inventoryColumns, INVENTORY_FROM, SERVICEABLE, TIME,
  findCenter, createCenter, updateCenter, assignOperator, upsertUser, receiveStock, inventoryItem, updateInventorySettings,
};
