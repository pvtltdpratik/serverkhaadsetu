const { HttpError } = require('../utils/http');
const { rearmLowStock } = require('./stockAlerts');
const { TODAY } = require('./surplus');

// Stock-holding primitives. All of them take `c`, a transaction client, so a
// hold changes atomically with the order that owns it.
//
// The core rule is one guarded UPDATE per line:
//   ... SET reserved = reserved + qty  WHERE on_hand - reserved >= qty
// Postgres locks the row for the UPDATE, so two farmers going for the last unit
// are serialised: the first wins, and the second's WHERE no longer matches
// (rowCount 0). No read-then-write gap exists to race through.

// Same order for every caller, so concurrent multi-item orders can't deadlock
// by locking the same rows in opposite orders.
const byProduct = (items) => [...items].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));

// Holds every line at one center, or none of them. Returns whether it held.
// A savepoint undoes the lines already held if a later one fails, without
// aborting the caller's whole transaction.
const tryReserve = async (c, centerId, items) => {
  await c.query('SAVEPOINT try_reserve');
  for (const { productId, quantity } of byProduct(items)) {
    const { rowCount } = await c.query(
      `UPDATE center_inventory SET reserved = reserved + $3
        WHERE center_id = $1 AND product_id = $2 AND on_hand - reserved >= $3`,
      [centerId, productId, quantity],
    );
    if (!rowCount) {
      await c.query('ROLLBACK TO SAVEPOINT try_reserve');
      await c.query('RELEASE SAVEPOINT try_reserve');
      return false;
    }
  }
  await c.query('RELEASE SAVEPOINT try_reserve');
  return true;
};

// Regular shelf lines, and (separately) lines that hold units from a surplus lot.
const heldLines = (order) => order.items.filter((i) => i.productId && !i.surplusLotId);
const lotLines = (order) => order.items.filter((i) => i.surplusLotId);
const byLot = (items) => [...items].sort((a, b) => (a.surplusLotId < b.surplusLotId ? -1 : a.surplusLotId > b.surplusLotId ? 1 : 0));

// Holds units from surplus lots, all or nothing (the caller's transaction rolls
// back everything else it held). Same guarded UPDATE as the shelf: the WHERE
// clause is the availability check, so two farmers can't both take the last unit.
// `centerId` pins the lots to the center the order is going to.
const reserveLots = async (c, centerId, items) => {
  for (const { surplusLotId, quantity } of byLot(items)) {
    const { rowCount } = await c.query(
      `UPDATE surplus_lot SET reserved = reserved + $3
        WHERE id = $1 AND center_id = $2 AND status = 'active' AND quantity - reserved >= $3
          AND (best_before IS NULL OR best_before >= ${TODAY})`,
      [surplusLotId, centerId, quantity],
    );
    if (!rowCount) {
      throw new HttpError(409, 'That surplus offer just sold out or is no longer available.', { code: 'surplus_unavailable', surplusLotId });
    }
  }
};

// Gives a lot's held units back. If the lot has been withdrawn meanwhile, the
// units leave it: back to the shelf when the lot was marked down from there
// (best effort: if the shelf has since filled up they are written off rather
// than failing the cancel or the expiry job), otherwise they simply go.
const releaseLotUnits = async (c, items) => {
  for (const { surplusLotId, quantity } of byLot(items)) {
    const { rows } = await c.query(
      `UPDATE surplus_lot SET reserved = GREATEST(reserved - $2, 0) WHERE id = $1
        RETURNING center_id, product_id, from_shelf, status`,
      [surplusLotId, quantity],
    );
    const lot = rows[0];
    if (!lot || lot.status !== 'withdrawn') continue;
    await c.query('UPDATE surplus_lot SET quantity = GREATEST(quantity - $2, 0) WHERE id = $1', [surplusLotId, quantity]);
    if (!lot.from_shelf) continue;
    await c.query('SAVEPOINT return_to_shelf');
    try {
      await c.query('UPDATE center_inventory SET on_hand = on_hand + $3 WHERE center_id = $1 AND product_id = $2', [lot.center_id, lot.product_id, quantity]);
      await c.query('RELEASE SAVEPOINT return_to_shelf');
      await rearmLowStock(c, lot.center_id, [lot.product_id]);
    } catch (err) {
      if (err.code !== '23514') throw err;
      await c.query('ROLLBACK TO SAVEPOINT return_to_shelf');
      await c.query('RELEASE SAVEPOINT return_to_shelf');
    }
  }
};

// Gives an order's held stock back to the shelf (cancel / expiry). A no-op for
// orders that hold nothing, so calling it twice is harmless.
const releaseOrderStock = async (c, order) => {
  if (!order.stockReserved || !order.centerId) return;
  for (const { productId, quantity } of byProduct(heldLines(order))) {
    await c.query(
      `UPDATE center_inventory SET reserved = GREATEST(reserved - $3, 0) WHERE center_id = $1 AND product_id = $2`,
      [order.centerId, productId, quantity],
    );
  }
  await releaseLotUnits(c, lotLines(order));
  await c.query('UPDATE orders SET stock_reserved = false WHERE id = $1', [order.id]);
  // More is available again, so a product that had dipped can alert on its next dip.
  await rearmLowStock(c, order.centerId, heldLines(order).map((i) => i.productId));
};

// The farmer collected the order: the goods leave the shelf, so on hand and
// reserved fall together (available is unchanged, it was already promised).
const consumeOrderStock = async (c, order) => {
  if (!order.stockReserved || !order.centerId) return;
  for (const { productId, quantity } of byProduct(heldLines(order))) {
    await c.query(
      `UPDATE center_inventory SET on_hand = on_hand - $3, reserved = GREATEST(reserved - $3, 0)
        WHERE center_id = $1 AND product_id = $2`,
      [order.centerId, productId, quantity],
    );
  }
  // Surplus units leave their lot the same way: sold, so quantity and reserved fall together.
  for (const { surplusLotId, quantity } of byLot(lotLines(order))) {
    await c.query('UPDATE surplus_lot SET quantity = GREATEST(quantity - $2, 0), reserved = GREATEST(reserved - $2, 0) WHERE id = $1', [surplusLotId, quantity]);
  }
  await c.query('UPDATE orders SET stock_reserved = false WHERE id = $1', [order.id]);
};

// A walk-in sale: the goods leave the shelf now, but only from what is not
// already promised to an app order. All-or-nothing when called in a transaction.
const deductWalkIn = async (c, centerId, lines) => {
  for (const { productId, productName, quantity } of byProduct(lines)) {
    const { rowCount } = await c.query(
      `UPDATE center_inventory SET on_hand = on_hand - $3
        WHERE center_id = $1 AND product_id = $2 AND on_hand - reserved >= $3`,
      [centerId, productId, quantity],
    );
    if (rowCount) continue;
    const { rows } = await c.query('SELECT on_hand, reserved FROM center_inventory WHERE center_id = $1 AND product_id = $2', [centerId, productId]);
    if (!rows.length) throw new HttpError(409, `${productName} is not in this center's stock`);
    const { on_hand: onHand, reserved } = rows[0];
    throw new HttpError(
      409,
      `Only ${onHand - reserved} of ${productName} available` + (reserved ? ` (${reserved} more reserved for app orders)` : '') + `, you asked for ${quantity}`,
    );
  }
};

// A walk-in sale of surplus units: they leave the lot now, but only what no app
// order is holding. Same guard as reserving, so it cannot race an online buyer.
const deductWalkInLots = async (c, centerId, lines) => {
  for (const { surplusLotId, productName, quantity } of byLot(lines)) {
    const { rowCount } = await c.query(
      `UPDATE surplus_lot SET quantity = quantity - $3
        WHERE id = $1 AND center_id = $2 AND status = 'active' AND quantity - reserved >= $3
          AND (best_before IS NULL OR best_before >= ${TODAY})`,
      [surplusLotId, centerId, quantity],
    );
    if (rowCount) continue;
    const { rows } = await c.query(
      `SELECT quantity - reserved AS free, reserved, status,
              (best_before IS NOT NULL AND best_before < ${TODAY}) AS past FROM surplus_lot WHERE id = $1 AND center_id = $2`,
      [surplusLotId, centerId],
    );
    if (!rows.length) throw new HttpError(404, 'Surplus lot not found');
    const lot = rows[0];
    if (lot.status !== 'active') throw new HttpError(409, `The surplus offer for ${productName} is no longer on sale`);
    if (lot.past) throw new HttpError(409, `The surplus offer for ${productName} is past its best-before date`);
    throw new HttpError(
      409,
      `Only ${lot.free} of the surplus ${productName} available` + (lot.reserved ? ` (${lot.reserved} more reserved for app orders)` : '') + `, you asked for ${quantity}`,
    );
  }
};

module.exports = { tryReserve, reserveLots, releaseOrderStock, consumeOrderStock, deductWalkIn, deductWalkInLots };
