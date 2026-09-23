const crypto = require('crypto');
const { HttpError } = require('../utils/http');

const ORDER_COLUMNS = 'id, customer_name AS "customerName", type, status, created_at AS "createdAt", pickup_otp AS "pickupOtp", owner_id AS "ownerId", center_id AS "centerId"';

const newOrderId = () => `order-${crypto.randomUUID()}`;
const newOtp = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

// Attaches `items` to order rows with one extra query (no N+1).
const withItems = async (q, orders) => {
  if (!orders.length) return orders;
  const { rows } = await q.query(
    `SELECT order_id, product_name AS "productName", quantity, unit_price AS "unitPrice"
       FROM order_items WHERE order_id = ANY($1) ORDER BY order_id, position`,
    [orders.map((o) => o.id)],
  );
  const byOrder = new Map(orders.map((o) => [o.id, []]));
  for (const { order_id, ...item } of rows) byOrder.get(order_id).push(item);
  return orders.map((o) => ({ ...o, items: byOrder.get(o.id) }));
};

const totalOf = (order) => order.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);

// The pickup OTP is the farmer's secret: only the farmer-facing endpoints
// reveal it. The operator app types in what the farmer reads out and the
// server does the comparison, so the operator API never returns it.
const serializeOrder = (order, { includeOtp }) => {
  const { ownerId, ...rest } = order;
  return {
    ...rest,
    pickupOtp: includeOtp ? order.pickupOtp : null,
    totalAmount: totalOf(order),
    itemCount: order.items.reduce((sum, i) => sum + i.quantity, 0),
  };
};

// `lock` adds FOR UPDATE (inside a transaction) so two requests can't both
// act on the same order's current state.
const findOrder = async (q, id, { lock = false } = {}) => {
  const { rows } = await q.query(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows.length) throw new HttpError(404, 'Order not found');
  return (await withItems(q, rows))[0];
};

// `onCancelled(client)` runs in the same transaction as the status change.
const cancelOrder = async (db, id, onCancelled) =>
  db.tx(async (c) => {
    const order = await findOrder(c, id, { lock: true });
    if (order.status !== 'pending' && order.status !== 'readyForPickup') {
      throw new HttpError(409, `A ${order.status} order cannot be cancelled`);
    }
    await c.query("UPDATE orders SET status = 'cancelled', pickup_otp = NULL WHERE id = $1", [id]);
    if (onCancelled) await onCancelled(c, order);
    return { ...order, status: 'cancelled', pickupOtp: null };
  });

const insertOrder = async (c, order) => {
  await c.query(
    'INSERT INTO orders (id, customer_name, type, status, created_at, pickup_otp, owner_id, center_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [order.id, order.customerName, order.type, order.status, order.createdAt, order.pickupOtp, order.ownerId, order.centerId || null],
  );
  for (const [i, item] of order.items.entries()) {
    await c.query(
      'INSERT INTO order_items (order_id, position, product_name, quantity, unit_price) VALUES ($1,$2,$3,$4,$5)',
      [order.id, i, item.productName, item.quantity, item.unitPrice],
    );
  }
};

module.exports = { ORDER_COLUMNS, serializeOrder, newOrderId, newOtp, findOrder, cancelOrder, withItems, insertOrder };
