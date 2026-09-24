process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';
// Many quick requests from one address, including deliberate wrong codes.
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.RATE_LIMIT_OTP = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');

// A delivery from the order to the doorstep: the two codes, following along, the
// partner's money, ratings, and the operator's tools.
let server;
let base;
let db;
let counter = 0;
let testImage;

const call = async (method, path, { body, device = 'farmer-1' } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-device-id': device },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const errorText = (res) => res.json?.error?.message ?? res.json?.error ?? '';

const upload = async (device, kind, buffer) => {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), 'papers');
  return fetch(`${base}/v1/delivery/partner/documents/${kind}`, { method: 'POST', headers: { 'x-device-id': device }, body: form });
};

let zoneCounter = 100;
const nextZone = () => (zoneCounter += 1) * 0.5;

const makeCenter = async (key, dLat = 0) => {
  counter += 1;
  const op = `op-${key}-${counter}`;
  await call('GET', '/v1/me', { device: op });
  const res = await call('POST', '/v1/admin/centers', {
    device: 'admin',
    body: { name: `Center ${key}`, village: key, latitude: 18.5 + dLat, longitude: 74.0, operatorId: op, opensAt: '00:00', closesAt: '23:59' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  await call('POST', '/v1/operator/inventory/receive', { device: op, body: { productId: 'p-vermicompost', quantity: 100 } });
  return { ...res.json, device: op };
};

let plate = 8000;
const makePartner = async (name, center, o = {}) => {
  const { vehicleType = 'pickup', capacityKg = 600, dLat = 0.01, online = true, approve = true } = o;
  const device = `pt-${name}-${counter += 1}`;
  await call('PUT', '/v1/farmer/profile', { device, body: { name: `Partner ${name}`, village: 'Shirur' } });
  const saved = await call('PUT', '/v1/delivery/partner', {
    device, body: { vehicleType, vehicleNumber: `MH12YY${(plate += 1)}`, capacityKg, phone: '9876500000', maxDistanceKm: 10, freeFrom: '00:00', freeUntil: '23:59', reviewCenterId: center.centerId },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  await upload(device, 'licence', await testImage());
  await upload(device, 'rc', await testImage());
  assert.equal((await call('POST', '/v1/delivery/partner/submit', { device })).status, 200);
  if (!approve) return device;
  assert.equal((await call('POST', `/v1/operator/delivery-partners/${device}/approve`, { device: center.device, body: {} })).status, 200);
  await call('PUT', '/v1/delivery/partner/location', { device, body: { latitude: center.latitude + dLat, longitude: center.longitude } });
  if (online) await call('PUT', '/v1/delivery/partner/online', { device, body: { online: true } });
  return device;
};

const address = (c, extra = {}) => ({ latitude: c.latitude + 0.045, longitude: c.longitude, phone: '98765 43210', label: 'Near the temple', village: 'Shirur', ...extra });
const orderDelivery = (c, device, extra = {}, addr = {}) =>
  call('POST', '/v1/orders', {
    device,
    body: { centerId: c.centerId, items: [{ productId: 'p-vermicompost', quantity: 1 }], fulfilment: 'delivery', deliveryAddress: address(c, addr), ...extra },
  });
const jobOf = async (orderId) => (await db.query('SELECT * FROM delivery_job WHERE order_id = $1', [orderId])).rows[0];
const alerts = async (device) => (await call('GET', '/v1/farmer/notifications', { device })).json.filter((n) => n.type === 'delivery');
const accept = (device, jobId) => call('POST', `/v1/delivery/jobs/${jobId}/accept`, { device });
const handover = (c, jobId, otp) => call('POST', `/v1/operator/deliveries/${jobId}/handover`, { device: c.device, body: { otp } });
const deliver = (device, jobId, otp) => call('POST', `/v1/delivery/jobs/${jobId}/deliver`, { device, body: { otp } });
const track = (device, orderId) => call('GET', `/v1/orders/${orderId}/delivery`, { device });
const stock = async (c) => (await db.query('SELECT on_hand, reserved FROM center_inventory WHERE center_id = $1 AND product_id = $2', [c.centerId, 'p-vermicompost'])).rows[0];
const wrongCode = (real) => (real === '0000' ? '1111' : '0000');

// One order taken all the way to "on its way to the buyer".
const inTransit = async (name) => {
  const c = await makeCenter(name, nextZone());
  const partner = await makePartner(`${name}p`, c);
  const buyer = `buyer-${name}`;
  const order = (await orderDelivery(c, buyer)).json;
  const job = await jobOf(order.id);
  const seen = (await accept(partner, job.id)).json;
  assert.equal((await handover(c, job.id, seen.handoverCode)).status, 200);
  return { c, partner, buyer, order, job, dropCode: (await track(buyer, order.id)).json.dropCode };
};

test.before(async () => {
  const { openTestDb, testImage: image } = require('./helpers');
  const { createApp } = require('../src/app');
  testImage = image;
  db = await openTestDb('t_delivery_flow');
  const app = createApp(db);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

// ---------------------------------------------------------------------------
// The whole journey
// ---------------------------------------------------------------------------

test('Suresh orders, Ramesh delivers: both codes, the money, and both ratings', async () => {
  const c = await makeCenter('journey', nextZone());
  const ramesh = await makePartner('ramesh', c);
  const suresh = 'suresh-journey';

  // Suresh orders 40 kg with home delivery; the fee is Rs 60.
  const placed = await orderDelivery(c, suresh);
  assert.equal(placed.status, 201, JSON.stringify(placed.json));
  assert.equal(placed.json.deliveryFee, 60);
  assert.equal(placed.json.delivery.status, 'open');
  assert.equal(placed.json.delivery.stage, 'Finding a delivery partner');
  assert.equal(placed.json.delivery.partner, null);
  assert.equal(placed.json.delivery.dropCode, null, 'nobody is coming yet');
  const job = await jobOf(placed.json.id);
  assert.deepEqual(await stock(c), { on_hand: 100, reserved: 1 });

  // Ramesh gets the notification and accepts.
  const offer = (await call('GET', '/v1/delivery/jobs/offers', { device: ramesh })).json[0];
  assert.equal(offer.id, job.id);
  const mine = (await accept(ramesh, job.id)).json;
  assert.equal(mine.status, 'assigned');
  assert.equal(mine.handoverCode, job.pickup_otp);

  // Suresh sees who is coming, and his own code.
  const t1 = (await track(suresh, placed.json.id)).json;
  assert.equal(t1.status, 'assigned');
  assert.equal(t1.partner.name, 'Partner ramesh');
  assert.equal(t1.partner.vehicleLabel, 'Pickup / small van');
  assert.match(t1.partner.vehicleNumber, /^MH12YY\d+$/);
  assert.equal(t1.partner.phone, '9876500000');
  assert.equal(t1.dropCode, job.drop_otp);
  assert.equal(t1.payableAmount, 510);

  // Ramesh shares where he is; Suresh follows him toward the center.
  await call('PUT', '/v1/delivery/partner/location', { device: ramesh, body: { latitude: c.latitude + 0.02, longitude: c.longitude } });
  const t2 = (await track(suresh, placed.json.id)).json;
  assert.equal(t2.nextStop, 'center');
  assert.equal(t2.distanceToNextStopKm, 2.9);
  assert.ok(t2.etaMinutes >= 1);
  assert.equal(t2.partnerLocation.latitude, c.latitude + 0.02);

  // At the counter: a wrong code first, then the right one.
  const wrong = await handover(c, job.id, wrongCode(job.pickup_otp));
  assert.equal(wrong.status, 400);
  assert.match(errorText(wrong), /4 tries left/);
  assert.equal(wrong.json.attemptsLeft, 4);
  assert.deepEqual(await stock(c), { on_hand: 100, reserved: 1 }, 'the goods have not left the shelf');
  const handed = await handover(c, job.id, job.pickup_otp);
  assert.equal(handed.status, 200, JSON.stringify(handed.json));
  assert.equal(handed.json.status, 'in_transit');
  assert.equal(handed.json.partnerName, 'Partner ramesh');
  assert.deepEqual(await stock(c), { on_hand: 99, reserved: 0 }, 'now they have');
  assert.equal((await handover(c, job.id, job.pickup_otp)).status, 409, 'not twice');
  const onTheWay = (await alerts(suresh)).find((n) => n.title === 'Your order is on its way');
  assert.match(onTheWay.body, new RegExp(`delivery code ${job.drop_otp}`));
  assert.match(onTheWay.body, /pay Rs 510 in cash/);
  assert.equal((await call('GET', `/v1/orders/${placed.json.id}`, { device: suresh })).json.status, 'readyForPickup');

  // Ramesh is heading to Suresh's farm.
  await call('PUT', '/v1/delivery/partner/location', { device: ramesh, body: { latitude: c.latitude + 0.03, longitude: c.longitude } });
  const t3 = (await track(suresh, placed.json.id)).json;
  assert.equal(t3.status, 'in_transit');
  assert.equal(t3.nextStop, 'you');
  assert.equal(t3.distanceToNextStopKm, 2.2);

  // At the farm: Suresh reads out his code.
  const bad = await deliver(ramesh, job.id, wrongCode(job.drop_otp));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.attemptsLeft, 4);
  assert.equal((await call('GET', `/v1/orders/${placed.json.id}`, { device: suresh })).json.status, 'readyForPickup');
  const done = await deliver(ramesh, job.id, job.drop_otp);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.status, 'delivered');
  assert.equal((await call('GET', `/v1/orders/${placed.json.id}`, { device: suresh })).json.status, 'completed');
  assert.equal((await track(suresh, placed.json.id)).json.status, 'delivered');
  assert.equal((await db.query('SELECT home_center_id FROM profiles WHERE owner_id = $1', [suresh])).rows[0].home_center_id, c.centerId);
  assert.ok((await alerts(suresh)).some((n) => n.title === 'Delivered'));
  const earned = (await alerts(ramesh)).find((n) => n.title === 'You earned Rs 60');
  assert.match(earned.body, /hand Rs 450 to the village center/);
  assert.ok((await alerts(c.device)).some((n) => n.title === 'A delivery was completed'));

  // Ramesh's wallet: the fee is his, the goods cash is owed to the center.
  const wallet = (await call('GET', '/v1/delivery/wallet', { device: ramesh })).json;
  assert.equal(wallet.earned, 60);
  assert.equal(wallet.owed, 450);
  assert.deepEqual(wallet.owedByCenter.map((o) => [o.centerName, o.owed]), [['Center journey', 450]]);
  assert.deepEqual(wallet.entries.map((e) => e.kind).sort(), ['fee_earned', 'goods_owed']);
  assert.equal(wallet.deliveriesDone, 1);

  // The operator sees the debt and clears it as the cash arrives.
  const owed = (await call('GET', '/v1/operator/delivery-cash', { device: c.device })).json;
  assert.deepEqual(owed.map((o) => [o.partnerId, o.owed]), [[ramesh, 450]]);
  assert.equal((await call('POST', `/v1/operator/delivery-cash/${ramesh}/settle`, { device: c.device, body: { amount: 500 } })).status, 409, 'more than he owes');
  const part = await call('POST', `/v1/operator/delivery-cash/${ramesh}/settle`, { device: c.device, body: { amount: 200, note: 'Part payment' } });
  assert.equal(part.status, 200);
  assert.equal(part.json[0].owed, 250);
  assert.match((await alerts(ramesh)).find((n) => n.title === 'The center recorded your cash').body, /still owe Rs 250/);
  assert.equal((await call('POST', `/v1/operator/delivery-cash/${ramesh}/settle`, { device: c.device, body: { amount: 250 } })).json.length, 0, 'nothing owed now');
  assert.equal((await call('POST', `/v1/operator/delivery-cash/${ramesh}/settle`, { device: c.device, body: { amount: 1 } })).status, 409);
  const after = (await call('GET', '/v1/delivery/wallet', { device: ramesh })).json;
  assert.equal(after.owed, 0);
  assert.equal(after.earned, 60);

  // Each rates the other, once.
  const stars = await call('POST', `/v1/orders/${placed.json.id}/delivery/rate`, { device: suresh, body: { stars: 5, comment: 'On time' } });
  assert.equal(stars.status, 204);
  assert.equal((await call('POST', `/v1/orders/${placed.json.id}/delivery/rate`, { device: suresh, body: { stars: 1 } })).status, 409);
  assert.equal((await call('POST', `/v1/delivery/jobs/${job.id}/rate-buyer`, { device: ramesh, body: { stars: 4 } })).status, 204);
  assert.equal((await call('POST', `/v1/delivery/jobs/${job.id}/rate-buyer`, { device: ramesh, body: { stars: 4 } })).status, 409);
  const partner = (await call('GET', '/v1/delivery/partner', { device: ramesh })).json;
  assert.equal(partner.ratingAvg, 5);
  assert.equal(partner.ratingCount, 1);
  assert.equal(partner.deliveriesDone, 1);
  assert.equal((await track(suresh, placed.json.id)).json.rated, true);
});

test('an order carries its delivery wherever it is listed', async () => {
  const c = await makeCenter('listing', nextZone());
  const buyer = 'listing-buyer';
  const placed = (await orderDelivery(c, buyer)).json;
  const one = (await call('GET', `/v1/orders/${placed.id}`, { device: buyer })).json;
  assert.equal(one.delivery.status, 'open');
  assert.equal(one.delivery.fee, 60);
  const list = (await call('GET', '/v1/orders', { device: buyer })).json;
  assert.equal(list[0].delivery.jobId, one.delivery.jobId);
  const plain = (await call('POST', '/v1/orders', { device: buyer, body: { centerId: c.centerId, items: [{ productId: 'p-vermicompost', quantity: 1 }] } })).json;
  assert.equal(plain.delivery, null, 'a pickup order has no delivery');
  assert.equal((await track(buyer, plain.id)).status, 404);
  assert.equal((await track('someone-else', placed.id)).status, 404, 'not their order');
});

// ---------------------------------------------------------------------------
// The codes
// ---------------------------------------------------------------------------

test('each code is shown only to the person who reads it out, and never to the operator', async () => {
  const { c, partner, buyer, order, job } = await inTransit('secret');
  const partnerView = JSON.stringify((await call('GET', `/v1/delivery/jobs/${job.id}`, { device: partner })).json);
  const buyerView = JSON.stringify((await track(buyer, order.id)).json);
  const operatorView = JSON.stringify((await call('GET', `/v1/operator/deliveries/${job.id}`, { device: c.device })).json);
  const operatorList = JSON.stringify((await call('GET', '/v1/operator/deliveries', { device: c.device })).json);
  assert.ok(!partnerView.includes(job.drop_otp) || job.drop_otp === job.pickup_otp, "the partner never sees the buyer's code");
  assert.ok(!buyerView.includes(`"${job.pickup_otp}"`) || job.drop_otp === job.pickup_otp, "the buyer never sees the partner's code");
  assert.ok(!operatorView.includes(`"${job.drop_otp}"`) && !operatorView.includes(`"${job.pickup_otp}"`), 'the operator sees neither');
  assert.ok(!operatorList.includes(`"${job.drop_otp}"`) && !operatorList.includes(`"${job.pickup_otp}"`));
  // The handover code disappears from the partner's view once it has been used.
  assert.equal(JSON.parse(partnerView).handoverCode, null);
  const orderView = JSON.stringify((await call('GET', `/v1/orders/${order.id}`, { device: buyer })).json);
  assert.ok(!orderView.includes(`"pickupOtp":"${job.pickup_otp}"`), 'and not through the order either');
});

test('five wrong codes in a row lock that step, even for the right code', async () => {
  const c = await makeCenter('lock', nextZone());
  const partner = await makePartner('lockp', c);
  const order = (await orderDelivery(c, 'lock-buyer')).json;
  const job = await jobOf(order.id);
  await accept(partner, job.id);
  const bad = wrongCode(job.pickup_otp);
  const lefts = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await handover(c, job.id, bad);
    assert.equal(r.status, 400);
    lefts.push(r.json.attemptsLeft);
  }
  assert.deepEqual(lefts, [4, 3, 2, 1, 0]);
  const locked = await handover(c, job.id, job.pickup_otp);
  assert.equal(locked.status, 429, 'the right code is refused while locked');
  assert.match(errorText(locked), /wait \d+ minutes?/);
  assert.equal((await jobOf(order.id)).status, 'assigned', 'nothing moved');
  assert.deepEqual(await stock(c), { on_hand: 100, reserved: 1 });
});

test('a right code clears the count of wrong ones', async () => {
  const { c, partner, order, job } = await inTransit('reset');
  // Drop step: four wrong, then right. The count must not have carried.
  for (let i = 0; i < 4; i += 1) assert.equal((await deliver(partner, job.id, wrongCode(job.drop_otp))).status, 400);
  assert.equal((await deliver(partner, job.id, job.drop_otp)).status, 200);
  assert.equal((await db.query('SELECT drop_failed FROM delivery_job WHERE id = $1', [job.id])).rows[0].drop_failed, 0);
  assert.ok(c && order);
});

test('codes must be four digits, and only the right people can use them', async () => {
  const { c, partner, job } = await inTransit('who');
  const other = await makePartner('whoother', c);
  assert.equal((await deliver(partner, job.id, '12')).status, 400);
  assert.equal((await deliver(partner, job.id, undefined)).status, 400);
  assert.equal((await deliver(other, job.id, job.drop_otp)).status, 404, 'not his delivery');
  assert.equal((await deliver('not-a-partner', job.id, job.drop_otp)).status, 404);
  const otherCenter = await makeCenter('who-other', nextZone());
  assert.equal((await handover(otherCenter, job.id, job.pickup_otp)).status, 404, "another center's operator");
  assert.equal((await call('POST', `/v1/operator/deliveries/${job.id}/handover`, { device: 'just-a-farmer', body: { otp: job.pickup_otp } })).status, 403);
  assert.equal((await handover(c, job.id, 'abcd')).status, 409, 'already handed over');
});

test('the steps come in order: no delivering before the handover, none handing over before someone accepts', async () => {
  const c = await makeCenter('order-of', nextZone());
  const partner = await makePartner('oo', c);
  const order = (await orderDelivery(c, 'oo-buyer')).json;
  const job = await jobOf(order.id);
  const early = await handover(c, job.id, '1234');
  assert.equal(early.status, 409);
  assert.match(errorText(early), /No delivery partner has taken this job yet/);
  await accept(partner, job.id);
  const tooSoon = await deliver(partner, job.id, job.drop_otp);
  assert.equal(tooSoon.status, 409);
  assert.match(errorText(tooSoon), /Collect the goods from the village center first/);
  assert.equal((await call('POST', `/v1/delivery/jobs/${job.id}/rate-buyer`, { device: partner, body: { stars: 5 } })).status, 409, 'not delivered yet');
  assert.equal((await call('POST', `/v1/orders/${order.id}/delivery/rate`, { device: 'oo-buyer', body: { stars: 5 } })).status, 409);
});

// ---------------------------------------------------------------------------
// Changing your mind
// ---------------------------------------------------------------------------

test('the buyer can switch to collecting it themselves until it is on the road', async () => {
  const c = await makeCenter('switch', nextZone());
  const partner = await makePartner('sw', c);
  const buyer = 'switch-buyer';
  const order = (await orderDelivery(c, buyer)).json;
  const job = await jobOf(order.id);
  await accept(partner, job.id);

  const res = await call('POST', `/v1/orders/${order.id}/delivery/cancel`, { device: buyer });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.fulfilment, 'pickup');
  assert.equal(res.json.deliveryFee, 0);
  assert.equal(res.json.payableAmount, 450);
  assert.match(res.json.pickupOtp, /^\d{4}$/, 'a counter code now');
  assert.equal(res.json.delivery.status, 'cancelled');
  assert.equal((await jobOf(order.id)).status, 'cancelled');
  assert.match((await alerts(partner)).find((n) => n.title === 'A delivery was cancelled').body, /The buyer chose to collect the order/);
  assert.match((await alerts(buyer)).find((n) => n.title === 'Delivery cancelled').body, new RegExp(`pickup code is ${res.json.pickupOtp}`));
  assert.equal((await call('GET', '/v1/delivery/jobs/active', { device: partner })).json.length, 0);
  assert.equal((await call('POST', `/v1/orders/${order.id}/delivery/cancel`, { device: buyer })).status, 409, 'it is already off');
  assert.equal((await call('POST', `/v1/orders/${order.id}/delivery/cancel`, { device: 'stranger' })).status, 404);

  // The plain counter flow then works.
  await call('POST', `/v1/operator/orders/${order.id}/ready`, { device: c.device });
  assert.equal((await call('POST', `/v1/operator/orders/${order.id}/verify-otp`, { device: c.device, body: { otp: res.json.pickupOtp } })).status, 200);
});

test('once the goods are on the road they cannot be called back', async () => {
  const { buyer, order, job, partner } = await inTransit('roadblock');
  const sw = await call('POST', `/v1/orders/${order.id}/delivery/cancel`, { device: buyer });
  assert.equal(sw.status, 409);
  assert.match(errorText(sw), /already on its way/);
  const cancel = await call('POST', `/v1/orders/${order.id}/cancel`, { device: buyer });
  assert.equal(cancel.status, 409);
  assert.match(errorText(cancel), /already on its way/);
  const drop = await call('POST', `/v1/delivery/jobs/${job.id}/decline`, { device: partner });
  assert.equal(drop.status, 409);
  assert.match(errorText(drop), /already collected/);
  assert.equal((await jobOf(order.id)).status, 'in_transit');
});

test('a delivered order is finished: it cannot be cancelled or switched', async () => {
  const { buyer, order, job, partner, dropCode } = await inTransit('finished');
  await deliver(partner, job.id, dropCode);
  assert.equal((await call('POST', `/v1/orders/${order.id}/cancel`, { device: buyer })).status, 409);
  const sw = await call('POST', `/v1/orders/${order.id}/delivery/cancel`, { device: buyer });
  assert.equal(sw.status, 409);
  assert.match(errorText(sw), /already done/);
  assert.equal((await deliver(partner, job.id, dropCode)).status, 409, 'and it cannot be delivered twice');
});

// ---------------------------------------------------------------------------
// The operator
// ---------------------------------------------------------------------------

test('with nobody free the operator sees it needs a driver, sees who could go, and picks one', async () => {
  const c = await makeCenter('assign', nextZone());
  const offline = await makePartner('off', c, { online: false, dLat: 0.02 });
  const order = (await orderDelivery(c, 'assign-buyer')).json;
  const job = await jobOf(order.id);

  const list = (await call('GET', '/v1/operator/deliveries', { device: c.device })).json;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'open');
  assert.equal(list[0].needsDriver, true);
  assert.equal(list[0].offersPending, 0);
  assert.equal(list[0].fee, 60);
  assert.equal(list[0].weightKg, 40);
  assert.equal(list[0].cashToCollect, 510);
  assert.equal(list[0].dropVillage, 'Shirur');
  assert.equal(list[0].partnerId, null);

  // Someone who could go: approved, big enough. He is not online, but the operator knows him.
  const tooSmall = await makePartner('tiny', c, { vehicleType: 'bike', capacityKg: 20 });
  const near = await makePartner('near', c, { dLat: 0.01 });
  const candidates = (await call('GET', `/v1/operator/deliveries/${job.id}/candidates`, { device: c.device })).json;
  assert.deepEqual(candidates.map((p) => p.userId), [near, offline], 'free ones first, then nearest; too-small vehicles are not listed');
  assert.deepEqual(candidates.map((p) => p.freeNow), [true, false]);
  assert.ok(!candidates.some((p) => p.userId === tooSmall));
  assert.equal(candidates[0].toPickupKm, 1.4);

  // Picking an offline one is allowed.
  const res = await call('POST', `/v1/operator/deliveries/${job.id}/assign`, { device: c.device, body: { partnerId: offline } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.status, 'assigned');
  assert.equal(res.json.partnerId, offline);
  assert.equal(res.json.partnerName, 'Partner off');
  assert.equal(res.json.needsDriver, false);
  const told = (await alerts(offline)).find((n) => n.title === 'You were given a delivery job');
  assert.match(told.body, /Rs 60/);
  assert.equal((await call('GET', `/v1/delivery/jobs/${job.id}`, { device: offline })).json.handoverCode, job.pickup_otp);
  assert.ok((await alerts('assign-buyer')).some((n) => n.title === 'A delivery partner is on the way to the center'));

  // And it goes through like any other delivery.
  assert.equal((await handover(c, job.id, job.pickup_otp)).status, 200);
});

test('an operator can swap the partner before the goods go, but not after', async () => {
  const c = await makeCenter('swap', nextZone());
  const first = await makePartner('first', c, { dLat: 0.01 });
  const second = await makePartner('second', c, { dLat: 0.02 });
  const order = (await orderDelivery(c, 'swap-buyer')).json;
  const job = await jobOf(order.id);
  await accept(first, job.id);
  const swap = await call('POST', `/v1/operator/deliveries/${job.id}/assign`, { device: c.device, body: { partnerId: second } });
  assert.equal(swap.status, 200);
  assert.equal(swap.json.partnerId, second);
  assert.ok((await alerts(first)).some((n) => n.title === 'This delivery was given to someone else'));
  assert.equal((await call('GET', '/v1/delivery/jobs/active', { device: first })).json.length, 0);
  assert.equal((await call('GET', '/v1/delivery/jobs/active', { device: second })).json.length, 1);
  assert.equal((await call('POST', `/v1/operator/deliveries/${job.id}/assign`, { device: c.device, body: { partnerId: second } })).status, 409, 'he already has it');

  const fresh = (await call('GET', `/v1/delivery/jobs/${job.id}`, { device: second })).json;
  await handover(c, job.id, fresh.handoverCode);
  const late = await call('POST', `/v1/operator/deliveries/${job.id}/assign`, { device: c.device, body: { partnerId: first } });
  assert.equal(late.status, 409);
  assert.match(errorText(late), /already on the road/);
});

test('an operator cannot hand a job to someone who cannot do it', async () => {
  const c = await makeCenter('cannot', nextZone());
  const small = await makePartner('small', c, { vehicleType: 'bike', capacityKg: 20 });
  const busy = await makePartner('busy', c);
  const pending = await makePartner('pend', c, { approve: false });
  const busyOrder = (await orderDelivery(c, 'cannot-b1')).json;
  await accept(busy, (await jobOf(busyOrder.id)).id);
  const selfPartner = await makePartner('self', c);
  const order = (await orderDelivery(c, selfPartner)).json;
  const job = await jobOf(order.id);
  const assign = (partnerId) => call('POST', `/v1/operator/deliveries/${job.id}/assign`, { device: c.device, body: { partnerId } });

  assert.match(errorText(await assign(small)), /carries 20 kg, but this load is 40 kg/);
  assert.match(errorText(await assign(busy)), /already on a delivery/);
  assert.equal((await assign(pending)).status, 404, 'not approved');
  assert.equal((await assign('nobody')).status, 404);
  assert.match(errorText(await assign(selfPartner)), /own order/);
  assert.equal((await call('POST', `/v1/operator/deliveries/${job.id}/assign`, { device: c.device, body: {} })).status, 400);
  const otherCenter = await makeCenter('cannot-other', nextZone());
  assert.equal((await call('POST', `/v1/operator/deliveries/${job.id}/assign`, { device: otherCenter.device, body: { partnerId: busy } })).status, 404, "another center's job");
  assert.equal((await call('GET', `/v1/operator/deliveries/${job.id}`, { device: otherCenter.device })).status, 404);
  assert.equal((await call('GET', `/v1/operator/deliveries/${job.id}/candidates`, { device: otherCenter.device })).status, 404);
});

test('the deliveries list shows what needs attention first, and can be filtered', async () => {
  const c = await makeCenter('board', nextZone());
  const partner = await makePartner('boardp', c);
  const onRoad = (await orderDelivery(c, 'board-1')).json;
  const j1 = await jobOf(onRoad.id);
  await accept(partner, j1.id);
  await handover(c, j1.id, (await call('GET', `/v1/delivery/jobs/${j1.id}`, { device: partner })).json.handoverCode);
  const waiting = (await orderDelivery(c, 'board-2')).json; // partner is busy, so nobody for this one
  const statuses = (await call('GET', '/v1/operator/deliveries', { device: c.device })).json.map((d) => d.status);
  assert.deepEqual(statuses, ['open', 'in_transit'], 'waiting for a driver comes before on the road');
  assert.equal((await call('GET', '/v1/operator/deliveries?status=in_transit', { device: c.device })).json.length, 1);
  assert.equal((await call('GET', '/v1/operator/deliveries?status=bogus', { device: c.device })).status, 400);
  assert.equal((await call('GET', '/v1/operator/deliveries', { device: 'just-a-farmer' })).status, 403);
  assert.ok(waiting.id);

  const admin = (await call('GET', `/v1/admin/deliveries?centerId=${c.centerId}`, { device: 'admin' })).json;
  assert.equal(admin.length, 2);
  assert.equal(admin[0].centerName, 'Center board');
  assert.equal((await call('GET', `/v1/admin/deliveries?centerId=${c.centerId}&status=open`, { device: 'admin' })).json.length, 1);
  assert.equal((await call('GET', '/v1/admin/deliveries?status=bogus', { device: 'admin' })).status, 400);
});

// ---------------------------------------------------------------------------
// Money and ratings, edge cases
// ---------------------------------------------------------------------------

test('a partner with no deliveries has an empty wallet', async () => {
  const c = await makeCenter('empty', nextZone());
  const p = await makePartner('emptyp', c);
  const w = (await call('GET', '/v1/delivery/wallet', { device: p })).json;
  assert.deepEqual([w.earned, w.owed, w.entries.length, w.owedByCenter.length, w.deliveriesDone], [0, 0, 0, 0, 0]);
  assert.equal((await call('GET', '/v1/delivery/wallet', { device: 'nobody-yet' })).status, 200);
});

test('several deliveries add up, per center, and cash is settled per center', async () => {
  const c = await makeCenter('sum', nextZone());
  const p = await makePartner('sump', c);
  for (const [name, qty] of [['sum-1', 1], ['sum-2', 2]]) {
    const order = (await call('POST', '/v1/orders', {
      device: name, body: { centerId: c.centerId, items: [{ productId: 'p-vermicompost', quantity: qty }], fulfilment: 'delivery', deliveryAddress: address(c) },
    })).json;
    const job = await jobOf(order.id);
    const mine = (await accept(p, job.id)).json;
    await handover(c, job.id, mine.handoverCode);
    await deliver(p, job.id, (await track(name, order.id)).json.dropCode);
  }
  const w = (await call('GET', '/v1/delivery/wallet', { device: p })).json;
  assert.equal(w.deliveriesDone, 2);
  assert.equal(w.owed, 450 + 900);
  assert.ok(w.earned > 60, 'the heavier delivery paid more');
  assert.equal(w.owedByCenter.length, 1);
  assert.equal((await call('POST', `/v1/operator/delivery-cash/${p}/settle`, { device: c.device, body: { amount: 0 } })).status, 400, 'a real amount');
  assert.equal((await call('POST', `/v1/operator/delivery-cash/${p}/settle`, { device: c.device, body: { amount: 1350 } })).json.length, 0);
  const otherCenter = await makeCenter('sum-other', nextZone());
  assert.equal((await call('POST', `/v1/operator/delivery-cash/${p}/settle`, { device: otherCenter.device, body: { amount: 5 } })).status, 409, 'he owes nothing to that center');
});

test('ratings need a real delivery, real stars, and the right person', async () => {
  const { buyer, order, job, partner, dropCode } = await inTransit('rating');
  await deliver(partner, job.id, dropCode);
  assert.equal((await call('POST', `/v1/orders/${order.id}/delivery/rate`, { device: buyer, body: { stars: 0 } })).status, 400);
  assert.equal((await call('POST', `/v1/orders/${order.id}/delivery/rate`, { device: buyer, body: { stars: 6 } })).status, 400);
  assert.equal((await call('POST', `/v1/orders/${order.id}/delivery/rate`, { device: buyer, body: { stars: 2.5 } })).status, 400);
  assert.equal((await call('POST', `/v1/orders/${order.id}/delivery/rate`, { device: 'stranger', body: { stars: 5 } })).status, 404);
  assert.equal((await call('POST', `/v1/delivery/jobs/${job.id}/rate-buyer`, { device: buyer, body: { stars: 5 } })).status, 404, 'the buyer cannot rate as the partner');
  assert.equal((await call('POST', `/v1/orders/${order.id}/delivery/rate`, { device: buyer, body: { stars: 3, comment: 'Late' } })).status, 204);

  // The average is over all ratings.
  const c2 = await makeCenter('rating2', nextZone());
  const p2 = await makePartner('rating2p', c2);
  const ratings = [5, 4, 3];
  for (const [i, stars] of ratings.entries()) {
    const o = (await orderDelivery(c2, `rate-${i}`)).json;
    const j = await jobOf(o.id);
    const mine = (await accept(p2, j.id)).json;
    await handover(c2, j.id, mine.handoverCode);
    await deliver(p2, j.id, (await track(`rate-${i}`, o.id)).json.dropCode);
    await call('POST', `/v1/orders/${o.id}/delivery/rate`, { device: `rate-${i}`, body: { stars } });
  }
  const view = (await call('GET', '/v1/delivery/partner', { device: p2 })).json;
  assert.equal(view.ratingCount, 3);
  assert.equal(view.ratingAvg, 4);
});
