const crypto = require('crypto');
const { HttpError } = require('../utils/http');
const { notify } = require('./notifications');

const money = (n) => Math.round(Number(n) * 100) / 100;

// The platform wallet is a ledger: credits and debits, and a balance that is their sum. Money
// enters it as resale earnings and refunds, and leaves it when an order is paid from it.
const addEntry = async (c, owner, amount, kind, refId = null, note = '') => {
  if (!owner || !amount) return;
  await c.query(
    'INSERT INTO farmer_wallet_entry (entry_id, owner_id, amount, kind, ref_id, note) VALUES ($1,$2,$3,$4,$5,$6)',
    [`wal-${crypto.randomUUID()}`, owner, money(amount), kind, refId, note],
  );
};

const balanceOf = async (q, owner) =>
  money((await q.query('SELECT COALESCE(SUM(amount), 0) AS b FROM farmer_wallet_entry WHERE owner_id = $1', [owner])).rows[0].b);

const entriesOf = async (q, owner, limit = 50) =>
  (await q.query(
    `SELECT entry_id AS "entryId", amount::float8 AS amount, kind, ref_id AS "refId", note, created_at AS "createdAt"
       FROM farmer_wallet_entry WHERE owner_id = $1 ORDER BY created_at DESC, entry_id LIMIT $2`, [owner, limit],
  )).rows;

// Pays the goods of one of the caller's open orders from the wallet balance. All of it or nothing:
// the wallet does not part-pay. Like an online payment, it leaves only the delivery fee for cash.
const payOrder = async (db, { owner, orderId }) =>
  db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wallet:${owner}`]);
    const order = (await c.query('SELECT id, owner_id, status, payment_status, center_id FROM orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
    if (!order || order.owner_id !== owner) throw new HttpError(404, 'Order not found');
    if (order.status !== 'pending' && order.status !== 'readyForPickup') throw new HttpError(409, `A ${order.status} order cannot be paid`);
    if (order.payment_status === 'paid') throw new HttpError(409, 'This order is already paid');
    const onTheWay = (await c.query("SELECT 1 FROM delivery_job WHERE order_id = $1 AND status IN ('in_transit','delivered')", [orderId])).rows.length > 0;
    if (onTheWay) throw new HttpError(409, 'This order is already on its way, so it is paid in cash on delivery');
    const total = money((await c.query('SELECT COALESCE(SUM(quantity * unit_price), 0) AS t FROM order_items WHERE order_id = $1', [orderId])).rows[0].t);
    if (total <= 0) throw new HttpError(409, 'There is nothing to pay for this order');
    const balance = await balanceOf(c, owner);
    if (balance < total) throw new HttpError(409, `Your wallet has Rs ${balance}, this order needs Rs ${total}. Pay online or at the center instead.`);

    await addEntry(c, owner, -total, 'order_payment', orderId, 'Paid for an order');
    await c.query(
      `INSERT INTO payment (payment_id, owner_id, order_id, amount_paise, razorpay_order_id, razorpay_payment_id, status, method, paid_at)
       VALUES ($1,$2,$3,$4,$5,$5,'paid','wallet', now())`,
      [`pay-${crypto.randomUUID()}`, owner, orderId, Math.round(total * 100), `wallet_${crypto.randomUUID()}`],
    );
    await c.query("UPDATE orders SET payment_status = 'paid', paid_at = now() WHERE id = $1", [orderId]);
    await c.query("UPDATE delivery_job SET goods_amount = 0 WHERE order_id = $1 AND status IN ('open','assigned')", [orderId]);
    await notify(c, owner, { type: 'order', title: 'Paid from your wallet', body: `Rs ${total} was taken from your wallet. Just collect your order when it is ready.`, refId: orderId });
    const operator = order.center_id ? (await c.query('SELECT operator_id FROM village_center WHERE center_id = $1', [order.center_id])).rows[0] : null;
    if (operator) await notify(c, operator.operator_id, { type: 'order', title: 'Order paid from wallet', body: 'A farmer paid for an order from their wallet, so no cash is due for the goods.', refId: orderId });
    return { orderId, paid: total, balance: money(balance - total) };
  });

module.exports = { addEntry, balanceOf, entriesOf, payOrder, money };
