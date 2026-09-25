const express = require('express');
const { HttpError, asyncHandler, str, body, deviceId } = require('../utils/http');
const payments = require('../services/payments');

// Online payment for an order's goods. The Razorpay key SECRET never leaves the server: the app
// gets only the public key id, a Razorpay order id and, afterwards, sends back the signature
// Razorpay's checkout produced, which is verified here.
module.exports = (db, razorpay) => {
  const router = express.Router();
  const ah = asyncHandler;

  // Whether the checkout can be offered, and the public key it needs.
  router.get('/config', ah(async (req, res) => res.json({ enabled: razorpay.enabled, keyId: razorpay.keyId })));

  router.post('/orders', ah(async (req, res) => {
    const owner = deviceId(req);
    const input = body(req);
    const contact = (await db.query('SELECT contact_email AS email, contact_phone AS phone FROM profiles WHERE owner_id = $1', [owner])).rows[0] || {};
    res.status(201).json(await payments.startPayment(db, razorpay, {
      owner, orderId: str(input.orderId, 'orderId', { max: 100 }), contact: { email: contact.email || req.userEmail || '', phone: contact.phone || '' },
    }));
  }));

  router.post('/verify', ah(async (req, res) => {
    const input = body(req);
    res.json(await payments.verifyPayment(db, razorpay, {
      owner: deviceId(req),
      razorpayOrderId: str(input.razorpayOrderId, 'razorpayOrderId', { max: 100 }),
      razorpayPaymentId: str(input.razorpayPaymentId, 'razorpayPaymentId', { max: 100 }),
      signature: str(input.razorpaySignature, 'razorpaySignature', { max: 200 }),
    }));
  }));

  router.get('/orders/:orderId', ah(async (req, res) => res.json(await payments.paymentsForOrder(db, deviceId(req), req.params.orderId))));

  return router;
};

// Razorpay's own server-to-server call, for when the app closed before it could verify. It carries
// no user login or API key, so it is checked by its signature over the raw body instead.
module.exports.webhook = (db, razorpay) => asyncHandler(async (req, res) => {
  if (!razorpay.verifyWebhook(req.rawBody, req.get('x-razorpay-signature'))) throw new HttpError(400, 'Bad signature');
  const event = req.body || {};
  const payment = event.payload && event.payload.payment && event.payload.payment.entity;
  if ((event.event === 'payment.captured' || event.event === 'order.paid') && payment && payment.order_id && payment.id) {
    try {
      await payments.markPaid(db, { razorpayOrderId: payment.order_id, razorpayPaymentId: payment.id });
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err; // a payment that is not ours is ignored
    }
  }
  res.json({ ok: true });
});
