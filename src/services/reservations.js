const { HttpError } = require('../utils/http');
const { rearmLowStock } = require('./stockAlerts');

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

const heldLines = (order) => order.items.filter((i) => i.productId);

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

module.exports = { tryReserve, releaseOrderStock, consumeOrderStock, deductWalkIn };
