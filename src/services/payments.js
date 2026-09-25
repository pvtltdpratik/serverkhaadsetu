const crypto = require('crypto');
const { HttpError } = require('../utils/http');
const { notify } = require('./notifications');

const PAYMENT_COLUMNS = `payment_id AS "paymentId", order_id AS "orderId", amount_paise AS "amountPaise", currency,
  razorpay_order_id AS "razorpayOrderId", status, created_at AS "createdAt", paid_at AS "paidAt"`;

const money = (n) => Math.round(Number(n) * 100) / 100;

// What the buyer pays online: the goods. The delivery fee (if any) is paid in cash to the partner.
const goodsPaise = async (q, orderId) => {
  const { rows } = await q.query('SELECT COALESCE(SUM(quantity * unit_price), 0) AS total FROM order_items WHERE order_id = $1', [orderId]);
  return Math.round(Number(rows[0].total) * 100);
};

// Starts (or resumes) an online payment for one of the caller's orders. Returns what the app
// needs to open Razorpay's checkout. The amount is always worked out here, never taken from the app.
const startPayment = async (db, razorpay, { owner, orderId, contact = {} }) => {
  if (!razorpay.enabled) throw new HttpError(503, 'Online payments are not set up on this server');
  const order = (await db.query('SELECT id, owner_id, status, payment_status, customer_name FROM orders WHERE id = $1', [orderId])).rows[0];
  if (!order || order.owner_id !== owner) throw new HttpError(404, 'Order not found');
  if (order.status !== 'pending' && order.status !== 'readyForPickup') throw new HttpError(409, `A ${order.status} order cannot be paid`);
  if (order.payment_status === 'paid') throw new HttpError(409, 'This order is already paid');
  const job = (await db.query("SELECT status FROM delivery_job WHERE order_id = $1 AND status IN ('in_transit','delivered')", [orderId])).rows[0];
  if (job) throw new HttpError(409, 'This order is already on its way, so it is paid in cash on delivery');
  const amountPaise = await goodsPaise(db, orderId);
  if (amountPaise <= 0) throw new HttpError(409, 'There is nothing to pay for this order');

  const describe = (row) => ({
    paymentId: row.payment_id,
    keyId: razorpay.keyId,
    razorpayOrderId: row.razorpay_order_id,
    amount: row.amount_paise,
    currency: row.currency,
    name: 'ShetSamrudhi',
    description: `Order ${orderId.slice(-8)}`,
    prefill: { name: order.customer_name, email: contact.email || '', contact: contact.phone || '' },
  });

  // Tapping "Pay" twice must not create two Razorpay orders: an unpaid one for the same amount is reused.
  const open = (await db.query(
    "SELECT * FROM payment WHERE order_id = $1 AND status = 'created' AND amount_paise = $2 ORDER BY created_at DESC LIMIT 1", [orderId, amountPaise],
  )).rows[0];
  if (open) return describe(open);

  const paymentId = `pay-${crypto.randomUUID()}`;
  const created = await razorpay.createOrder({ amountPaise, receipt: paymentId, notes: { orderId, owner } });
  if (!created || !created.id) throw new HttpError(502, 'The payment service gave an unexpected answer');
  const row = (await db.query(
    `INSERT INTO payment (payment_id, owner_id, order_id, amount_paise, razorpay_order_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [paymentId, owner, orderId, amountPaise, created.id],
  )).rows[0];
  return describe(row);
};

// Records that Razorpay took the money. Idempotent: the app's verify call and Razorpay's webhook
// both arrive, in either order, and only the first changes anything.
const markPaid = async (db, { razorpayOrderId, razorpayPaymentId }) =>
  db.tx(async (c) => {
    const pay = (await c.query('SELECT * FROM payment WHERE razorpay_order_id = $1 FOR UPDATE', [razorpayOrderId])).rows[0];
    if (!pay) throw new HttpError(404, 'Payment not found');
    if (pay.status !== 'created') return { ...pay, alreadyHandled: true };

    const order = (await c.query('SELECT id, owner_id, status, payment_status, center_id FROM orders WHERE id = $1 FOR UPDATE', [pay.order_id])).rows[0];
    const other = (await c.query("SELECT 1 FROM payment WHERE order_id = $1 AND status IN ('paid','refund_pending') AND payment_id <> $2", [pay.order_id, pay.payment_id])).rows.length > 0;

    // Money arrived for an order that can no longer take it (cancelled meanwhile, or already paid
    // through another payment): give it straight back.
    if (!order || (order.status !== 'pending' && order.status !== 'readyForPickup') || order.payment_status === 'paid' || other) {
      await c.query(
        "UPDATE payment SET status = 'refund_pending', razorpay_payment_id = $2, paid_at = now(), failure = 'The order could not take this payment' WHERE payment_id = $1",
        [pay.payment_id, razorpayPaymentId],
      );
      await notify(c, pay.owner_id, { type: 'order', title: 'Payment will be refunded', body: 'Your payment arrived after the order could no longer accept it. It is being refunded.', refId: pay.order_id });
      return { ...pay, status: 'refund_pending' };
    }

    await c.query("UPDATE payment SET status = 'paid', razorpay_payment_id = $2, paid_at = now() WHERE payment_id = $1", [pay.payment_id, razorpayPaymentId]);
    await c.query("UPDATE orders SET payment_status = 'paid', paid_at = now() WHERE id = $1", [pay.order_id]);
    // The goods are paid, so a delivery partner has no goods cash to collect for this order.
    await c.query("UPDATE delivery_job SET goods_amount = 0 WHERE order_id = $1 AND status IN ('open','assigned')", [pay.order_id]);
    await notify(c, pay.owner_id, {
      type: 'order', title: 'Payment received', body: `We received Rs ${money(pay.amount_paise / 100)}. Just collect your order when it is ready.`, refId: pay.order_id,
    });
    const operator = order.center_id ? (await c.query('SELECT operator_id FROM village_center WHERE center_id = $1', [order.center_id])).rows[0] : null;
    if (operator) {
      await notify(c, operator.operator_id, { type: 'order', title: 'Order paid online', body: 'A farmer paid for an order online, so no cash is due for the goods.', refId: pay.order_id });
    }
    return { ...pay, status: 'paid' };
  });

// The app returns from Razorpay's checkout with a signature. It is checked here with the secret.
const verifyPayment = async (db, razorpay, { owner, razorpayOrderId, razorpayPaymentId, signature }) => {
  const pay = (await db.query('SELECT owner_id FROM payment WHERE razorpay_order_id = $1', [razorpayOrderId])).rows[0];
  if (!pay || pay.owner_id !== owner) throw new HttpError(404, 'Payment not found');
  if (!razorpay.verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, signature)) {
    throw new HttpError(400, 'The payment could not be verified. If money was taken from your account it will be refunded.');
  }
  const done = await markPaid(db, { razorpayOrderId, razorpayPaymentId });
  return { orderId: done.order_id, status: done.status };
};

// Called inside the transaction that cancels an order: a paid order is queued for a refund.
const markRefundPending = async (c, orderId) => {
  const { rowCount } = await c.query("UPDATE payment SET status = 'refund_pending' WHERE order_id = $1 AND status = 'paid'", [orderId]);
  if (rowCount) await c.query("UPDATE orders SET payment_status = 'refunded' WHERE id = $1", [orderId]);
  return rowCount > 0;
};

// Sends every queued refund to Razorpay. A failure is recorded and retried on the next run.
const processRefunds = async (db, razorpay) => {
  if (!razorpay.enabled) return { refunded: 0, failed: 0 };
  const due = (await db.query("SELECT payment_id, owner_id, order_id, razorpay_payment_id, amount_paise FROM payment WHERE status = 'refund_pending' AND razorpay_payment_id IS NOT NULL ORDER BY paid_at LIMIT 20")).rows;
  let refunded = 0;
  let failed = 0;
  for (const p of due) {
    try {
      const r = await razorpay.refund(p.razorpay_payment_id, { amountPaise: p.amount_paise, notes: { orderId: p.order_id } });
      await db.tx(async (c) => {
        await c.query("UPDATE payment SET status = 'refunded', refund_id = $2, refunded_at = now(), failure = '' WHERE payment_id = $1 AND status = 'refund_pending'", [p.payment_id, r.id || '']);
        await notify(c, p.owner_id, { type: 'order', title: 'Refund sent', body: `Rs ${money(p.amount_paise / 100)} is being returned to your account. It can take 5 to 7 working days.`, refId: p.order_id });
      });
      refunded += 1;
    } catch (err) {
      failed += 1;
      await db.query('UPDATE payment SET failure = $2 WHERE payment_id = $1', [p.payment_id, String(err.message).slice(0, 300)]);
    }
  }
  return { refunded, failed };
};

const paymentsForOrder = async (db, owner, orderId) =>
  (await db.query(`SELECT ${PAYMENT_COLUMNS} FROM payment WHERE order_id = $1 AND owner_id = $2 ORDER BY created_at DESC`, [orderId, owner])).rows;

module.exports = { startPayment, markPaid, verifyPayment, markRefundPending, processRefunds, paymentsForOrder, goodsPaise };
