const crypto = require('crypto');
const { HttpError } = require('../utils/http');

const API = 'https://api.razorpay.com/v1';

const safeEqualHex = (a, b) => {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');

// A thin client for the parts of Razorpay we use. The key SECRET stays inside this object, on
// the server: it signs API calls and checks signatures, and is never sent to the app.
// `fetchImpl` is injectable so tests never call the real API.
const createRazorpay = ({ keyId, keySecret, webhookSecret = '', fetchImpl = fetch } = {}) => {
  const enabled = Boolean(keyId && keySecret);
  const auth = enabled ? `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` : '';

  const request = async (path, body) => {
    if (!enabled) throw new HttpError(503, 'Online payments are not set up on this server');
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new HttpError(502, 'Could not reach the payment service. Please try again.');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = json && json.error && json.error.description ? json.error.description : `status ${res.status}`;
      throw new HttpError(res.status >= 500 ? 502 : 400, `The payment service refused this: ${reason}`);
    }
    return json;
  };

  const get = async (path) => {
    if (!enabled) throw new HttpError(503, 'Online payments are not set up on this server');
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, { method: 'GET', headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      throw new HttpError(502, 'Could not reach the payment service. Please try again.');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : 400, `The payment service refused this: status ${res.status}`);
    return json;
  };

  return {
    enabled,
    // The public half: safe to give to the app.
    keyId: enabled ? keyId : '',

    createOrder: ({ amountPaise, receipt, notes = {} }) => request('/orders', { amount: amountPaise, currency: 'INR', receipt, notes }),

    // The payment Razorpay already took on this order, if any. The app can miss the answer (an error
    // screen, a lost signal) after the money has gone through, so the server asks before offering the order again.
    capturedPayment: async (razorpayOrderId) => {
      const json = await get(`/orders/${encodeURIComponent(razorpayOrderId)}/payments`);
      return (json.items || []).find((p) => p.status === 'captured') || null;
    },

    refund: (paymentId, { amountPaise, notes = {} }) => request(`/payments/${encodeURIComponent(paymentId)}/refund`, { amount: amountPaise, notes }),

    // Checkout hands the app (order id, payment id, signature). Only the secret can produce a
    // matching signature, so a match proves Razorpay took the money for that order.
    verifyPaymentSignature: (orderId, paymentId, signature) => enabled && safeEqualHex(hmac(keySecret, `${orderId}|${paymentId}`), signature),

    // Webhooks are signed with the webhook secret over the raw request body.
    verifyWebhook: (rawBody, signature) => Boolean(webhookSecret) && Buffer.isBuffer(rawBody) && safeEqualHex(hmac(webhookSecret, rawBody), signature),
  };
};

module.exports = { createRazorpay, hmac };
