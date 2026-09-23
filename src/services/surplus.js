const crypto = require('crypto');
const { HttpError } = require('../utils/http');
const { checkLowStock, rearmLowStock } = require('./stockAlerts');
const config = require('../config');

const CONDITIONS = ['near_expiry', 'opened', 'returned', 'damaged_packaging', 'other'];

// "Today" at the center, so a lot marked best-before today stays sellable all
// day whatever the server's own time zone is. The zone is operator config, not
// user input; quotes are stripped so it can never break out of the literal.
const TODAY = `(now() AT TIME ZONE '${config.centerTimezone.replace(/'/g, '')}')::date`;

// A lot a farmer can buy from right now.
const LOT_LIVE = `l.status = 'active' AND l.quantity - l.reserved > 0 AND (l.best_before IS NULL OR l.best_before >= ${TODAY})`;

const LOT_COLUMNS = `l.id, l.center_id AS "centerId", l.product_id AS "productId", p.name AS "productName", p.unit_label AS "unit",
  p.price_in_rupees AS "catalogPrice", l.unit_price AS "unitPrice", l.quantity, l.reserved, l.quantity - l.reserved AS "available",
  l.condition, to_char(l.best_before, 'YYYY-MM-DD') AS "bestBefore", l.note, l.from_shelf AS "fromShelf", l.created_at AS "createdAt",
  CASE WHEN l.status = 'withdrawn' THEN 'withdrawn'
       WHEN l.quantity = 0 THEN 'soldOut'
       WHEN l.best_before IS NOT NULL AND l.best_before < ${TODAY} THEN 'expired'
       ELSE 'active' END AS "status"`;
const LOT_FROM = 'surplus_lot l JOIN products p ON p.id = l.product_id';

const toMoney = (row) => ({
  ...row,
  catalogPrice: Number(row.catalogPrice),
  unitPrice: Number(row.unitPrice),
  discountPercent: Number(row.catalogPrice) > 0 ? Math.round((1 - Number(row.unitPrice) / Number(row.catalogPrice)) * 100) : 0,
});

const getLot = async (q, id, centerId) => {
  const { rows } = await q.query(
    `SELECT ${LOT_COLUMNS} FROM ${LOT_FROM} WHERE l.id = $1${centerId ? ' AND l.center_id = $2' : ''}`,
    centerId ? [id, centerId] : [id],
  );
  if (!rows.length) throw new HttpError(404, 'Surplus lot not found');
  return toMoney(rows[0]);
};

const checkPrice = (unitPrice, catalogPrice) => {
  if (unitPrice >= Number(catalogPrice)) {
    throw new HttpError(400, `A surplus price must be lower than the regular price (Rs ${Number(catalogPrice)})`);
  }
};

const createLot = async (db, { centerId, productId, quantity, unitPrice, condition, bestBefore, note, fromShelf }) => {
  const id = `lot-${crypto.randomUUID()}`;
  await db.tx(async (c) => {
    const product = (await c.query('SELECT price_in_rupees AS "price" FROM products WHERE id = $1', [productId])).rows[0];
    if (!product) throw new HttpError(404, 'Product not found');
    checkPrice(unitPrice, product.price);
    if (bestBefore) {
      const { rows: [{ ok }] } = await c.query(`SELECT $1::date >= ${TODAY} AS ok`, [bestBefore]);
      if (!ok) throw new HttpError(400, '"bestBefore" is already in the past');
    }
    if (fromShelf) {
      // Only what is not already promised to an app order can be marked down.
      const { rowCount } = await c.query(
        `UPDATE center_inventory SET on_hand = on_hand - $3
          WHERE center_id = $1 AND product_id = $2 AND on_hand - reserved >= $3`,
        [centerId, productId, quantity],
      );
      if (!rowCount) {
        const { rows } = await c.query('SELECT on_hand - reserved AS available FROM center_inventory WHERE center_id = $1 AND product_id = $2', [centerId, productId]);
        throw new HttpError(409, `Only ${rows.length ? rows[0].available : 0} of this product is available on the shelf, you asked to mark down ${quantity}`);
      }
      await checkLowStock(c, centerId, [productId]);
    }
    await c.query(
      `INSERT INTO surplus_lot (id, center_id, product_id, quantity, unit_price, condition, best_before, note, from_shelf)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, centerId, productId, quantity, unitPrice, condition, bestBefore || null, note || '', !!fromShelf],
    );
  });
  return getLot(db, id);
};

// Price and wording only. The units themselves change by selling or withdrawing.
const updateLot = async (db, { centerId, id, unitPrice, note }) => {
  const lot = await getLot(db, id, centerId);
  if (lot.status === 'withdrawn') throw new HttpError(409, 'A withdrawn lot cannot be changed');
  if (unitPrice !== undefined) checkPrice(unitPrice, lot.catalogPrice);
  const sets = [];
  const params = [id];
  if (unitPrice !== undefined) { params.push(unitPrice); sets.push(`unit_price = $${params.length}`); }
  if (note !== undefined) { params.push(note); sets.push(`note = $${params.length}`); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  await db.query(`UPDATE surplus_lot SET ${sets.join(', ')} WHERE id = $1`, params);
  return getLot(db, id);
};

// Takes the lot off sale. Units already held by an app order stay in the lot
// until that order ends; the rest go back to the shelf if they came from it.
const withdrawLot = async (db, { centerId, id }) => {
  try {
    await db.tx(async (c) => {
      const { rows } = await c.query(
        'SELECT product_id, quantity, reserved, from_shelf, status FROM surplus_lot WHERE id = $1 AND center_id = $2 FOR UPDATE',
        [id, centerId],
      );
      if (!rows.length) throw new HttpError(404, 'Surplus lot not found');
      const lot = rows[0];
      if (lot.status === 'withdrawn') throw new HttpError(409, 'That lot is already withdrawn');
      const free = lot.quantity - lot.reserved;
      await c.query(`UPDATE surplus_lot SET status = 'withdrawn', quantity = reserved WHERE id = $1`, [id]);
      if (lot.from_shelf && free > 0) {
        await c.query('UPDATE center_inventory SET on_hand = on_hand + $3 WHERE center_id = $1 AND product_id = $2', [centerId, lot.product_id, free]);
        await rearmLowStock(c, centerId, [lot.product_id]);
      }
    });
  } catch (err) {
    if (err.code === '23514') throw new HttpError(409, "Returning these units would exceed this center's storage capacity for the product");
    throw err;
  }
  return getLot(db, id);
};

module.exports = { CONDITIONS, LOT_LIVE, LOT_COLUMNS, LOT_FROM, TODAY, getLot, toMoney, createLot, updateLot, withdrawLot };
