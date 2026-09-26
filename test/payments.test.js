process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.RATE_LIMIT_OTP = '100000';
process.env.DELIVERY_OFFERS_PER_ROUND = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRazorpay, hmac } = require('../src/services/razorpay');
const payments = require('../src/services/payments');

const KEY_ID = 'rzp_test_publickey';
const SECRET = 'a-fake-secret-for-tests-only';
const WEBHOOK_SECRET = 'a-fake-webhook-secret';

let server;
let base;
let db;
let razorpay;
let counter = 0;
const razorpayCalls = [];
let failRefunds = false;
let fakeIds = 0;

// A stand-in for api.razorpay.com: records what would have been sent and answers like it does.
const alreadyCaptured = new Map(); // razorpay order id -> payment id that Razorpay took without telling the app
const fakeFetch = async (url, init) => {
  if (init.method === 'GET') {
    const m = url.match(/\/orders\/([^/]+)\/payments$/);
    const id = m && alreadyCaptured.get(m[1]);
    return new Response(JSON.stringify({ items: id ? [{ id, status: 'captured', method: 'upi' }] : [{ id: 'pay_failed1', status: 'failed' }] }), { status: 200 });
  }
  const body = JSON.parse(init.body);
  razorpayCalls.push({ url, auth: init.headers.Authorization, body });
  if (url.endsWith('/orders')) return new Response(JSON.stringify({ id: `order_R${(fakeIds += 1)}`, amount: body.amount }), { status: 200 });
  if (url.includes('/refund')) {
    if (failRefunds) return new Response(JSON.stringify({ error: { description: 'gateway down' } }), { status: 400 });
    return new Response(JSON.stringify({ id: `rfnd_${(fakeIds += 1)}` }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

const call = async (method, path, { body, device = 'buyer-1', headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-device-id': device, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
};

const makeCenter = async (key) => {
  counter += 1;
  const op = `op-${key}-${counter}`;
  await call('GET', '/v1/me', { device: op });
  const res = await call('POST', '/v1/admin/centers', {
    device: 'admin', body: { name: `Center ${key}`, village: key, latitude: 18.5 + counter * 0.5, longitude: 74.0, operatorId: op, opensAt: '00:00', closesAt: '23:59' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  await call('POST', '/v1/operator/inventory/receive', { device: op, body: { productId: 'p-vermicompost', quantity: 100 } });
  return { ...res.json, device: op };
};

const placeOrder = async (center, device) => {
  const r = await call('POST', '/v1/orders', { device, body: { centerId: center.centerId, items: [{ productId: 'p-vermicompost', quantity: 2 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
};

const pay = (razorpayOrderId, paymentId = 'pay_TEST1') => ({
  razorpayOrderId, razorpayPaymentId: paymentId, razorpaySignature: hmac(SECRET, `${razorpayOrderId}|${paymentId}`),
});

test.before(async () => {
  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  db = await openTestDb('t_payments');
  razorpay = createRazorpay({ keyId: KEY_ID, keySecret: SECRET, webhookSecret: WEBHOOK_SECRET, fetchImpl: fakeFetch });
  server = createApp(db, { razorpay }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

test('the app is given the public key id and never the secret', async () => {
  const cfg = await call('GET', '/v1/payments/config');
  assert.deepEqual(cfg.json, { enabled: true, keyId: KEY_ID });
  const c = await makeCenter('cfg');
  const order = await placeOrder(c, 'cfg-buyer');
  const started = await call('POST', '/v1/payments/orders', { device: 'cfg-buyer', body: { orderId: order.id } });
  assert.equal(started.status, 201, started.text);
  for (const r of [cfg, started]) {
    assert.ok(!r.text.includes(SECRET), 'the secret must never appear in a response');
  }
  assert.equal(started.json.keyId, KEY_ID);
});

test('with no keys configured, online payment is off and says so', async () => {
  const off = createRazorpay({});
  assert.equal(off.enabled, false);
  const { createApp } = require('../src/app');
  const s = createApp(db, { razorpay: off }).listen(0);
  try {
    const url = `http://127.0.0.1:${s.address().port}`;
    const cfg = await (await fetch(`${url}/v1/payments/config`, { headers: { 'x-device-id': 'x' } })).json();
    assert.deepEqual(cfg, { enabled: false, keyId: '' });
    const r = await fetch(`${url}/v1/payments/orders`, { method: 'POST', headers: { 'x-device-id': 'x', 'content-type': 'application/json' }, body: JSON.stringify({ orderId: 'o' }) });
    assert.equal(r.status, 503);
  } finally {
    s.close();
  }
});

test('the amount is worked out on the server from the order, and the Razorpay call uses the secret only in its login', async () => {
  const c = await makeCenter('amt');
  const order = await placeOrder(c, 'amt-buyer');
  razorpayCalls.length = 0;
  // Whatever the app claims about the amount is ignored.
  const started = await call('POST', '/v1/payments/orders', { device: 'amt-buyer', body: { orderId: order.id, amount: 1 } });
  assert.equal(started.status, 201);
  assert.equal(started.json.amount, Math.round(order.totalAmount * 100));
  assert.equal(started.json.currency, 'INR');
  assert.equal(razorpayCalls.length, 1);
  assert.equal(razorpayCalls[0].body.amount, Math.round(order.totalAmount * 100));
  assert.equal(razorpayCalls[0].auth, `Basic ${Buffer.from(`${KEY_ID}:${SECRET}`).toString('base64')}`);
  assert.ok(!JSON.stringify(razorpayCalls[0].body).includes(SECRET));
  // Tapping Pay again reuses the same Razorpay order.
  const again = await call('POST', '/v1/payments/orders', { device: 'amt-buyer', body: { orderId: order.id } });
  assert.equal(again.json.razorpayOrderId, started.json.razorpayOrderId);
  assert.equal(razorpayCalls.length, 1);
});

test('only the buyer can pay for their order, and only while it is open', async () => {
  const c = await makeCenter('own');
  const order = await placeOrder(c, 'own-buyer');
  assert.equal((await call('POST', '/v1/payments/orders', { device: 'someone-else', body: { orderId: order.id } })).status, 404);
  assert.equal((await call('POST', '/v1/payments/orders', { device: 'own-buyer', body: { orderId: 'order-nope' } })).status, 404);
  assert.equal((await call('POST', `/v1/orders/${order.id}/cancel`, { device: 'own-buyer' })).status, 200);
  assert.equal((await call('POST', '/v1/payments/orders', { device: 'own-buyer', body: { orderId: order.id } })).status, 409);
});

test('a verified payment marks the order paid, so no cash is due for the goods', async () => {
  const c = await makeCenter('paid');
  const order = await placeOrder(c, 'paid-buyer');
  assert.equal(order.paymentStatus, 'unpaid');
  const started = (await call('POST', '/v1/payments/orders', { device: 'paid-buyer', body: { orderId: order.id } })).json;

  const verified = await call('POST', '/v1/payments/verify', { device: 'paid-buyer', body: pay(started.razorpayOrderId) });
  assert.equal(verified.status, 200, verified.text);
  assert.deepEqual(verified.json, { orderId: order.id, status: 'paid' });

  const mine = (await call('GET', `/v1/orders/${order.id}`, { device: 'paid-buyer' })).json;
  assert.equal(mine.paymentStatus, 'paid');
  assert.equal(mine.payableAmount, 0);
  const seenByOperator = (await call('GET', `/v1/operator/orders/${order.id}`, { device: c.device })).json;
  assert.equal(seenByOperator.paymentStatus, 'paid');

  const alerts = (await call('GET', '/v1/farmer/notifications', { device: 'paid-buyer' })).json.map((n) => n.title);
  assert.ok(alerts.includes('Payment received'));
  const operatorAlerts = (await call('GET', '/v1/farmer/notifications', { device: c.device })).json.map((n) => n.title);
  assert.ok(operatorAlerts.includes('Order paid online'));

  // Verifying again (a retry, or the webhook arriving too) changes nothing.
  const twice = await call('POST', '/v1/payments/verify', { device: 'paid-buyer', body: pay(started.razorpayOrderId) });
  assert.equal(twice.status, 200);
  assert.equal((await call('GET', '/v1/farmer/notifications', { device: 'paid-buyer' })).json.filter((n) => n.title === 'Payment received').length, 1);
  assert.equal((await call('POST', '/v1/payments/orders', { device: 'paid-buyer', body: { orderId: order.id } })).status, 409, 'an order is paid once');
});

test('a forged or mismatched signature does not count', async () => {
  const c = await makeCenter('forge');
  const order = await placeOrder(c, 'forge-buyer');
  const started = (await call('POST', '/v1/payments/orders', { device: 'forge-buyer', body: { orderId: order.id } })).json;
  const forged = { razorpayOrderId: started.razorpayOrderId, razorpayPaymentId: 'pay_X', razorpaySignature: hmac('wrong-secret', `${started.razorpayOrderId}|pay_X`) };
  assert.equal((await call('POST', '/v1/payments/verify', { device: 'forge-buyer', body: forged })).status, 400);
  // A real signature for a different payment id does not transfer.
  const mismatched = { ...pay(started.razorpayOrderId, 'pay_A'), razorpayPaymentId: 'pay_B' };
  assert.equal((await call('POST', '/v1/payments/verify', { device: 'forge-buyer', body: mismatched })).status, 400);
  assert.equal((await call('POST', '/v1/payments/verify', { device: 'forge-buyer', body: { ...forged, razorpaySignature: 'abc' } })).status, 400);
  assert.equal((await call('POST', '/v1/payments/verify', { device: 'another', body: pay(started.razorpayOrderId) })).status, 404, 'not their payment');
  assert.equal((await call('GET', `/v1/orders/${order.id}`, { device: 'forge-buyer' })).json.paymentStatus, 'unpaid');
});

test('the webhook confirms a payment even if the app never came back, and rejects a bad signature', async () => {
  const c = await makeCenter('hook');
  const order = await placeOrder(c, 'hook-buyer');
  const started = (await call('POST', '/v1/payments/orders', { device: 'hook-buyer', body: { orderId: order.id } })).json;
  const event = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_HOOK', order_id: started.razorpayOrderId } } } };
  const raw = JSON.stringify(event);

  const bad = await fetch(`${base}/webhooks/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': hmac('nope', raw) }, body: raw });
  assert.equal(bad.status, 400);
  assert.equal((await call('GET', `/v1/orders/${order.id}`, { device: 'hook-buyer' })).json.paymentStatus, 'unpaid');

  const good = await fetch(`${base}/webhooks/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': hmac(WEBHOOK_SECRET, raw) }, body: raw });
  assert.equal(good.status, 200);
  assert.equal((await call('GET', `/v1/orders/${order.id}`, { device: 'hook-buyer' })).json.paymentStatus, 'paid');

  // A payment that is not ours is quietly ignored.
  const other = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_O', order_id: 'order_unknown' } } } });
  const ignored = await fetch(`${base}/webhooks/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': hmac(WEBHOOK_SECRET, other) }, body: other });
  assert.equal(ignored.status, 200);
});

test('cancelling a paid order sends the money back, and a failed refund is retried', async () => {
  const c = await makeCenter('refund');
  const order = await placeOrder(c, 'refund-buyer');
  const started = (await call('POST', '/v1/payments/orders', { device: 'refund-buyer', body: { orderId: order.id } })).json;
  await call('POST', '/v1/payments/verify', { device: 'refund-buyer', body: pay(started.razorpayOrderId, 'pay_REF') });

  assert.equal((await call('POST', `/v1/orders/${order.id}/cancel`, { device: 'refund-buyer' })).status, 200);
  const row = () => db.query('SELECT status, failure, refund_id FROM payment WHERE razorpay_order_id = $1', [started.razorpayOrderId]).then((r) => r.rows[0]);
  assert.equal((await row()).status, 'refund_pending');
  assert.equal((await call('GET', `/v1/orders/${order.id}`, { device: 'refund-buyer' })).json.paymentStatus, 'refunded');

  failRefunds = true;
  assert.deepEqual(await payments.processRefunds(db, razorpay), { refunded: 0, failed: 1 });
  assert.equal((await row()).status, 'refund_pending');
  assert.match((await row()).failure, /gateway down/);

  failRefunds = false;
  razorpayCalls.length = 0;
  assert.deepEqual(await payments.processRefunds(db, razorpay), { refunded: 1, failed: 0 });
  assert.equal((await row()).status, 'refunded');
  assert.ok((await row()).refund_id.startsWith('rfnd_'));
  const refundCall = razorpayCalls.find((x) => x.url.includes('/refund'));
  assert.ok(refundCall.url.includes('/payments/pay_REF/refund'));
  assert.equal(refundCall.body.amount, Math.round(order.totalAmount * 100));
  assert.ok((await call('GET', '/v1/farmer/notifications', { device: 'refund-buyer' })).json.some((n) => n.title === 'Refund sent'));

  // Nothing is refunded twice.
  assert.deepEqual(await payments.processRefunds(db, razorpay), { refunded: 0, failed: 0 });
});

test('money that arrives for an order that was cancelled meanwhile is refunded, not kept', async () => {
  const c = await makeCenter('late');
  const order = await placeOrder(c, 'late-buyer');
  const started = (await call('POST', '/v1/payments/orders', { device: 'late-buyer', body: { orderId: order.id } })).json;
  await call('POST', `/v1/orders/${order.id}/cancel`, { device: 'late-buyer' });
  const done = await payments.markPaid(db, { razorpayOrderId: started.razorpayOrderId, razorpayPaymentId: 'pay_LATE' });
  assert.equal(done.status, 'refund_pending');
  assert.deepEqual(await payments.processRefunds(db, razorpay), { refunded: 1, failed: 0 });
});

test('an expired reservation that was paid online is refunded too', async () => {
  const { runReservationMaintenance } = require('../src/services/reservationJobs');
  const c = await makeCenter('expire');
  const order = await placeOrder(c, 'expire-buyer');
  const started = (await call('POST', '/v1/payments/orders', { device: 'expire-buyer', body: { orderId: order.id } })).json;
  await call('POST', '/v1/payments/verify', { device: 'expire-buyer', body: pay(started.razorpayOrderId, 'pay_EXP') });
  const r = await runReservationMaintenance(db, new Date(Date.now() + 30 * 86400000));
  assert.ok(r.expired >= 1);
  assert.equal((await call('GET', `/v1/orders/${order.id}`, { device: 'expire-buyer' })).json.status, 'cancelled');
  assert.equal((await db.query('SELECT status FROM payment WHERE razorpay_order_id = $1', [started.razorpayOrderId])).rows[0].status, 'refund_pending');
});

test('a home delivery paid online leaves the partner only the fee to collect', async () => {
  const c = await makeCenter('deliv');
  const partner = `pt-pay-${counter}`;
  const { testImage } = require('./helpers');
  await call('PUT', '/v1/farmer/profile', { device: partner, body: { name: 'Partner Pay', village: 'Shirur' } });
  await call('PUT', '/v1/delivery/partner', {
    device: partner, body: { vehicleType: 'pickup', vehicleNumber: 'MH12PP0001', capacityKg: 600, phone: '9876500000', maxDistanceKm: 10, freeFrom: '00:00', freeUntil: '23:59', reviewCenterId: c.centerId },
  });
  for (const kind of ['licence', 'rc']) {
    const form = new FormData();
    form.append('file', new Blob([await testImage()], { type: 'image/jpeg' }), 'papers');
    await fetch(`${base}/v1/delivery/partner/documents/${kind}`, { method: 'POST', headers: { 'x-device-id': partner }, body: form });
  }
  await call('POST', '/v1/delivery/partner/submit', { device: partner });
  await call('POST', `/v1/operator/delivery-partners/${partner}/approve`, { device: c.device, body: {} });
  await call('PUT', '/v1/delivery/partner/location', { device: partner, body: { latitude: c.latitude + 0.01, longitude: c.longitude } });
  await call('PUT', '/v1/delivery/partner/online', { device: partner, body: { online: true } });

  const order = (await call('POST', '/v1/orders', {
    device: 'deliv-buyer',
    body: { centerId: c.centerId, items: [{ productId: 'p-vermicompost', quantity: 1 }], fulfilment: 'delivery', deliveryAddress: { latitude: c.latitude + 0.045, longitude: c.longitude, phone: '9876543210', label: 'Near the temple', village: 'Shirur' } },
  })).json;
  const before = (await db.query('SELECT goods_amount, fee FROM delivery_job WHERE order_id = $1', [order.id])).rows[0];
  assert.ok(Number(before.goods_amount) > 0);
  assert.equal(order.payableAmount, Number(before.goods_amount) + Number(before.fee));

  const started = (await call('POST', '/v1/payments/orders', { device: 'deliv-buyer', body: { orderId: order.id } })).json;
  assert.equal(started.amount, Math.round(order.totalAmount * 100), 'only the goods are paid online, not the delivery fee');
  await call('POST', '/v1/payments/verify', { device: 'deliv-buyer', body: pay(started.razorpayOrderId, 'pay_DEL') });

  const after = (await db.query('SELECT goods_amount, fee FROM delivery_job WHERE order_id = $1', [order.id])).rows[0];
  assert.equal(Number(after.goods_amount), 0);
  assert.equal(Number(after.fee), Number(before.fee));
  const mine = (await call('GET', `/v1/orders/${order.id}`, { device: 'deliv-buyer' })).json;
  assert.equal(mine.payableAmount, Number(before.fee), 'the buyer now owes only the delivery fee, in cash');
});

test('a payment Razorpay took but the app never heard about is settled the next time the farmer taps Pay', async () => {
  const c = await makeCenter('missed');
  const order = await placeOrder(c, 'missed-buyer');
  const started = (await call('POST', '/v1/payments/orders', { device: 'missed-buyer', body: { orderId: order.id } })).json;
  assert.equal((await call('GET', `/v1/orders/${order.id}`, { device: 'missed-buyer' })).json.paymentStatus, 'unpaid');

  // The farmer paid, but Razorpay's screen showed an error and the app never called verify.
  alreadyCaptured.set(started.razorpayOrderId, 'pay_TOOKMONEY');
  const again = await call('POST', '/v1/payments/orders', { device: 'missed-buyer', body: { orderId: order.id } });
  assert.equal(again.status, 409, 'the paid Razorpay order is not offered again');
  assert.match(again.json.error, /already paid/);

  const mine = (await call('GET', `/v1/orders/${order.id}`, { device: 'missed-buyer' })).json;
  assert.equal(mine.paymentStatus, 'paid');
  assert.equal(mine.payableAmount, 0);
  const alerts = (await call('GET', '/v1/farmer/notifications', { device: 'missed-buyer' })).json.map((n) => n.title);
  assert.ok(alerts.includes('Payment received'));
});

test('an unpaid Razorpay order is offered again, not created twice', async () => {
  const c = await makeCenter('lookup');
  const order = await placeOrder(c, 'lookup-buyer');
  const first = (await call('POST', '/v1/payments/orders', { device: 'lookup-buyer', body: { orderId: order.id } })).json;
  const before = razorpayCalls.length;
  const second = await call('POST', '/v1/payments/orders', { device: 'lookup-buyer', body: { orderId: order.id } });
  assert.equal(second.status, 201);
  assert.equal(second.json.razorpayOrderId, first.razorpayOrderId, 'the same unpaid Razorpay order is reused');
  assert.equal(razorpayCalls.length, before, 'no second order was created');
});
