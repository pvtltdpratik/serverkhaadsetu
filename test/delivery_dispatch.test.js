process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';
// These tests follow one job at a time; batching has its own test file.
process.env.DELIVERY_MAX_ACTIVE_JOBS = '1';
// This file sets up many partners in a few seconds, from one address.
process.env.RATE_LIMIT_PER_MINUTE = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');

// Ordering with home delivery, and how a job finds a partner: who is offered it,
// who gets it, and what happens when nobody does.
const fee = require('../src/services/deliveryFee');

let server;
let base;
let db;
let counter = 0;
let testImage;
let runDispatch;
let runReassignment;

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

// Each test lives in its own patch of map (55 km apart) so partners and centers
// from other tests are never near enough to matter.
let zoneCounter = 0;
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

let plate = 5000;
// An approved delivery partner living `dLat` degrees north of the center (0.01 is about 1.1 km).
const makePartner = async (name, center, o = {}) => {
  const { vehicleType = 'pickup', capacityKg = 600, dLat = 0.01, online = true, maxDistanceKm = 10, freeFrom = '00:00', freeUntil = '23:59', approve = true, located = true } = o;
  const device = `pt-${name}-${counter += 1}`;
  await call('PUT', '/v1/farmer/profile', { device, body: { name: `Partner ${name}`, village: 'Shirur' } });
  const saved = await call('PUT', '/v1/delivery/partner', {
    device, body: { vehicleType, vehicleNumber: `MH12ZZ${(plate += 1)}`, capacityKg, phone: '9876500000', maxDistanceKm, freeFrom, freeUntil, reviewCenterId: center.centerId },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  await upload(device, 'licence', await testImage());
  await upload(device, 'rc', await testImage());
  assert.equal((await call('POST', '/v1/delivery/partner/submit', { device })).status, 200);
  if (!approve) return device;
  assert.equal((await call('POST', `/v1/operator/delivery-partners/${device}/approve`, { device: center.device, body: {} })).status, 200);
  if (located) assert.equal((await call('PUT', '/v1/delivery/partner/location', { device, body: { latitude: center.latitude + dLat, longitude: center.longitude } })).status, 204);
  if (online) assert.equal((await call('PUT', '/v1/delivery/partner/online', { device, body: { online: true } })).status, 200);
  return device;
};

const address = (c, extra = {}) => ({ latitude: c.latitude + 0.045, longitude: c.longitude, phone: '98765 43210', label: 'Near the temple', village: 'Shirur', ...extra });
const orderDelivery = (c, device, extra = {}, addr = {}) =>
  call('POST', '/v1/orders', {
    device,
    body: { centerId: c.centerId, items: [{ productId: 'p-vermicompost', quantity: 1 }], fulfilment: 'delivery', deliveryAddress: address(c, addr), ...extra },
  });
const jobOf = async (orderId) => (await db.query('SELECT * FROM delivery_job WHERE order_id = $1', [orderId])).rows[0];
const offered = async (jobId) => (await db.query("SELECT partner_id FROM delivery_offer WHERE job_id = $1 ORDER BY round, partner_id", [jobId])).rows.map((r) => r.partner_id);
const offersOf = async (device) => (await call('GET', '/v1/delivery/jobs/offers', { device })).json;
const accept = (device, jobId) => call('POST', `/v1/delivery/jobs/${jobId}/accept`, { device });
const decline = (device, jobId) => call('POST', `/v1/delivery/jobs/${jobId}/decline`, { device });
const alerts = async (device) => (await call('GET', '/v1/farmer/notifications', { device })).json.filter((n) => n.type === 'delivery');
const minutesFromNow = (m) => new Date(Date.now() + m * 60000);
const tick = (m = 0) => runDispatch(db, { now: minutesFromNow(m) });

test.before(async () => {
  const { openTestDb, testImage: image } = require('./helpers');
  const { createApp } = require('../src/app');
  ({ runDeliveryDispatch: runDispatch } = require('../src/services/deliveryJobs'));
  ({ runReassignment } = require('../src/services/reassignment'));
  testImage = image;
  db = await openTestDb('t_delivery_dispatch');
  const app = createApp(db);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

// ---------------------------------------------------------------------------
// The fee, and timing
// ---------------------------------------------------------------------------

test('the fee comes from distance and weight: no bargaining, rounded up to the next Rs 5', () => {
  // The worked example: 40 kg over 5 km in a straight line (6.5 km by road).
  assert.equal(fee.roadKm(5), 6.5);
  assert.equal(fee.computeFee({ roadKm: 6.5, weightKg: 40 }), 60);
  assert.equal(fee.computeFee({ roadKm: 6.5, weightKg: 8 }), 55, 'a light load costs less: 25 + 26 = 51 -> 55');
  assert.equal(fee.computeFee({ roadKm: 0.5, weightKg: 1 }), 30, 'never below the minimum');
  assert.equal(fee.computeFee({ roadKm: 12, weightKg: 500 }), 25 + 48 + 98 + (5 - ((25 + 48 + 98) % 5)) % 5);
  assert.ok(fee.computeFee({ roadKm: 10, weightKg: 40 }) > fee.computeFee({ roadKm: 5, weightKg: 40 }), 'farther costs more');
  assert.ok(fee.computeFee({ roadKm: 5, weightKg: 200 }) > fee.computeFee({ roadKm: 5, weightKg: 40 }), 'heavier costs more');
  for (const km of [0.7, 3.3, 6.5, 11.1]) assert.equal(fee.computeFee({ roadKm: km, weightKg: 33 }) % 5, 0);
});

test('a load suggests a vehicle, and a trip an honest time', () => {
  assert.equal(fee.suggestVehicle(12), 'bike');
  assert.equal(fee.suggestVehicle(30), 'bike');
  assert.equal(fee.suggestVehicle(40), 'pickup');
  assert.equal(fee.suggestVehicle(500), 'pickup');
  assert.equal(fee.suggestVehicle(1200), 'tractor');
  assert.equal(fee.etaMinutes(15, 'bike'), 30);
  assert.equal(fee.etaMinutes(9, 'tractor'), 30);
  assert.equal(fee.etaMinutes(0.1, 'bike'), 1, 'never zero minutes');
});

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

test('a quote says the fee, the load, and whether anyone is free right now', async () => {
  const z = nextZone();
  const c = await makeCenter('quote', z);
  const quoteBody = { centerId: c.centerId, items: [{ productId: 'p-vermicompost', quantity: 1 }], latitude: c.latitude + 0.045, longitude: c.longitude };
  const none = await call('POST', '/v1/delivery/quote', { body: quoteBody });
  assert.equal(none.status, 200, JSON.stringify(none.json));
  assert.equal(none.json.available, true);
  assert.equal(none.json.fee, 60);
  assert.equal(none.json.weightKg, 40);
  assert.equal(none.json.roadKm, 6.5);
  assert.equal(none.json.suggestedVehicle, 'pickup');
  assert.equal(none.json.partnersFree, 0);
  assert.match(none.json.note, /No delivery partner is free right now/);
  assert.match(none.json.payment, /cash/);

  await makePartner('q1', c);
  const some = await call('POST', '/v1/delivery/quote', { body: quoteBody });
  assert.equal(some.json.partnersFree, 1);
  assert.match(some.json.note, /free right now/);
  // More of it costs more, and heavier.
  const more = await call('POST', '/v1/delivery/quote', { body: { ...quoteBody, items: [{ productId: 'p-vermicompost', quantity: 3 }] } });
  assert.equal(more.json.weightKg, 120);
  assert.ok(more.json.fee > 60);
});

test('a quote works out the nearest center itself, and says when the farm is out of reach', async () => {
  const z = nextZone();
  const c = await makeCenter('quote-far', z);
  const near = await call('POST', '/v1/delivery/quote', { body: { items: [{ productId: 'p-vermicompost', quantity: 1 }], latitude: c.latitude + 0.05, longitude: c.longitude } });
  assert.equal(near.json.centerId, c.centerId);
  const far = await call('POST', '/v1/delivery/quote', { body: { centerId: c.centerId, items: [{ productId: 'p-vermicompost', quantity: 1 }], latitude: c.latitude + 0.3, longitude: c.longitude } });
  assert.equal(far.status, 200);
  assert.equal(far.json.available, false);
  assert.equal(far.json.fee, null);
  assert.match(far.json.note, /within 20 km/);
  assert.equal((await call('POST', '/v1/delivery/quote', { body: { items: [], latitude: 1, longitude: 1 } })).status, 400);
  assert.equal((await call('POST', '/v1/delivery/quote', { body: { items: [{ productId: 'p-nope', quantity: 1 }], latitude: c.latitude, longitude: c.longitude, centerId: c.centerId } })).status, 404);
  assert.equal((await call('POST', '/v1/delivery/quote', { body: { centerId: 'center-nope', items: [{ productId: 'p-vermicompost', quantity: 1 }], latitude: 1, longitude: 1 } })).status, 404);
});

// ---------------------------------------------------------------------------
// Ordering with delivery
// ---------------------------------------------------------------------------

test('an order can be a home delivery: the fee is the server\'s, the counter code is not used, everyone is told', async () => {
  const c = await makeCenter('order', nextZone());
  const res = await orderDelivery(c, 'suresh', { deliveryFee: 1, fee: 1 });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.fulfilment, 'delivery');
  assert.equal(res.json.deliveryFee, 60, 'a fee sent by the client is ignored');
  assert.equal(res.json.totalAmount, 450);
  assert.equal(res.json.payableAmount, 510, 'goods + fee, paid in cash on arrival');
  assert.equal(res.json.pickupOtp, null, 'no counter code for a delivery');
  assert.equal(res.json.status, 'pending');

  const job = await jobOf(res.json.id);
  assert.equal(job.status, 'open');
  assert.equal(Number(job.fee), 60);
  assert.equal(Number(job.weight_kg), 40);
  assert.equal(Number(job.goods_amount), 450);
  assert.equal(job.drop_phone, '9876543210');
  assert.equal(job.drop_village, 'Shirur');
  assert.match(job.pickup_otp, /^\d{4}$/);
  assert.match(job.drop_otp, /^\d{4}$/);

  const buyer = (await call('GET', '/v1/farmer/notifications', { device: 'suresh' })).json.find((n) => n.title === 'Order placed');
  assert.match(buyer.body, /delivery partner/);
  assert.match(buyer.body, /Rs 60/);
  const operator = (await call('GET', '/v1/farmer/notifications', { device: c.device })).json.find((n) => n.title === 'New app order');
  assert.match(operator.body, /delivery partner will collect it/);
  assert.equal((await db.query('SELECT reserved FROM center_inventory WHERE center_id = $1 AND product_id = $2', [c.centerId, 'p-vermicompost'])).rows[0].reserved, 1, 'the stock is held as for any order');
});

test('an ordinary order is unchanged: a pickup code, no fee', async () => {
  const c = await makeCenter('plain', nextZone());
  const res = await call('POST', '/v1/orders', { device: 'plain-buyer', body: { centerId: c.centerId, items: [{ productId: 'p-vermicompost', quantity: 2 }] } });
  assert.equal(res.status, 201);
  assert.equal(res.json.fulfilment, 'pickup');
  assert.equal(res.json.deliveryFee, 0);
  assert.equal(res.json.payableAmount, 900);
  assert.match(res.json.pickupOtp, /^\d{4}$/);
  assert.equal(await jobOf(res.json.id), undefined);
});

test('a delivery needs an address and a phone, and is refused beyond reach without holding any stock', async () => {
  const c = await makeCenter('order-bad', nextZone());
  const stockNow = async () => (await db.query('SELECT on_hand, reserved FROM center_inventory WHERE center_id = $1 AND product_id = $2', [c.centerId, 'p-vermicompost'])).rows[0];
  const noAddress = await call('POST', '/v1/orders', { device: 'bad-1', body: { centerId: c.centerId, items: [{ productId: 'p-vermicompost', quantity: 1 }], fulfilment: 'delivery' } });
  assert.equal(noAddress.status, 400);
  assert.match(errorText(noAddress), /deliveryAddress/);
  assert.equal((await orderDelivery(c, 'bad-2', {}, { phone: '12345' })).status, 400);
  assert.equal((await orderDelivery(c, 'bad-3', {}, { latitude: 200 })).status, 400);
  assert.equal((await call('POST', '/v1/orders', { device: 'bad-4', body: { centerId: c.centerId, items: [{ productId: 'p-vermicompost', quantity: 1 }], fulfilment: 'teleport' } })).status, 400);

  const far = await orderDelivery(c, 'bad-5', {}, { latitude: c.latitude + 0.5 });
  assert.equal(far.status, 400);
  assert.equal(far.json.code, 'delivery_too_far');
  assert.match(errorText(far), /within 20 km/);
  assert.deepEqual(await stockNow(), { on_hand: 100, reserved: 0 }, 'nothing was held');
});

test('with no center chosen, only a center within reach of the farm is used', async () => {
  const z = nextZone();
  const near = await makeCenter('auto-near', z);
  await makeCenter('auto-farther', z + 0.3); // about 33 km further north
  const res = await call('POST', '/v1/orders', {
    device: 'auto-buyer',
    body: { items: [{ productId: 'p-vermicompost', quantity: 1 }], fulfilment: 'delivery', deliveryAddress: address(near) },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.centerId, near.centerId);
});

// ---------------------------------------------------------------------------
// Who is offered a job
// ---------------------------------------------------------------------------

test('the nearest partners are offered first, a few at a time, and each is told', async () => {
  const c = await makeCenter('nearest', nextZone());
  const p1 = await makePartner('n1', c, { dLat: 0.01 });
  const p2 = await makePartner('n2', c, { dLat: 0.02 });
  const p3 = await makePartner('n3', c, { dLat: 0.03 });
  const p4 = await makePartner('n4', c, { dLat: 0.05 });
  const order = (await orderDelivery(c, 'buyer-nearest')).json;
  const job = await jobOf(order.id);
  assert.deepEqual(await offered(job.id), [p1, p2, p3].sort(), 'the three nearest, not the fourth');
  assert.equal((await offersOf(p4)).length, 0);

  const mine = await offersOf(p1);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, job.id);
  assert.equal(mine[0].fee, 60);
  assert.equal(mine[0].weightKg, 40);
  assert.equal(mine[0].distanceKm, 6.5);
  assert.equal(mine[0].items, '1 x Vermicompost');
  assert.equal(mine[0].pickup.centerName, 'Center nearest');
  assert.ok(mine[0].offerExpiresAt);
  const told = (await alerts(p1))[0];
  assert.equal(told.title, 'Delivery job: Rs 60');
  assert.match(told.body, /40 kg from Center nearest, nearest to Shirur, 6\.5 km/);
  assert.equal(told.refId, job.id);
});

test('what he is not yet entitled to stays hidden until he accepts', async () => {
  const c = await makeCenter('privacy', nextZone());
  const p = await makePartner('priv', c);
  const order = (await orderDelivery(c, 'buyer-priv', {}, { label: 'Second house behind the school', note: 'Ring twice' })).json;
  const offer = (await offersOf(p))[0];
  const text = JSON.stringify(offer);
  assert.equal(offer.drop.village, 'Shirur', 'only the village');
  assert.ok(!text.includes('9876543210'), 'no phone yet');
  assert.ok(!text.includes('school'), 'no exact address yet');
  assert.equal(offer.handoverCode, undefined);
  assert.equal(offer.buyerName, undefined);
  assert.ok(order.id);
});

test('who is left out: too small a vehicle, off, out of hours, too far, not approved, no location, or the buyer himself', async () => {
  const c = await makeCenter('excluded', nextZone());
  const good = await makePartner('good', c);
  const tooSmall = await makePartner('small', c, { vehicleType: 'bike', capacityKg: 30 }); // 40 kg load
  const off = await makePartner('off', c, { online: false });
  const outOfHours = await makePartner('hours', c, { freeFrom: '00:00', freeUntil: '00:01' });
  const tooFar = await makePartner('reach', c, { maxDistanceKm: 2 });
  const pending = await makePartner('pending', c, { approve: false });
  const noLocation = await makePartner('nowhere', c, { located: false });
  const buyerPartner = await makePartner('self', c);

  const order = (await orderDelivery(c, buyerPartner)).json;
  const got = await offered((await jobOf(order.id)).id);
  assert.deepEqual(got, [good], 'only the one who fits');
  for (const left of [tooSmall, off, outOfHours, tooFar, pending, noLocation, buyerPartner]) assert.equal((await offersOf(left)).length, 0, left);
});

test('a partner already on a delivery is not offered another', async () => {
  const c = await makeCenter('busy', nextZone());
  const p = await makePartner('busy', c);
  const first = (await orderDelivery(c, 'busy-buyer-1')).json;
  assert.equal((await accept(p, (await jobOf(first.id)).id)).status, 200);
  const second = (await orderDelivery(c, 'busy-buyer-2')).json;
  assert.equal((await offered((await jobOf(second.id)).id)).length, 0);
});

// ---------------------------------------------------------------------------
// Accepting and declining
// ---------------------------------------------------------------------------

test('the first to accept gets the job with everything he needs; the others are told it is gone', async () => {
  const c = await makeCenter('accept', nextZone());
  const a = await makePartner('a', c, { dLat: 0.01 });
  const b = await makePartner('b', c, { dLat: 0.02 });
  const order = (await orderDelivery(c, 'buyer-accept', {}, { label: 'Behind the school', note: 'Ring twice' })).json;
  const job = await jobOf(order.id);

  const res = await accept(a, job.id);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.status, 'assigned');
  assert.equal(res.json.mine, true);
  assert.equal(res.json.drop.phone, '9876543210');
  assert.equal(res.json.drop.label, 'Behind the school');
  assert.equal(res.json.drop.note, 'Ring twice');
  assert.equal(res.json.drop.latitude, c.latitude + 0.045);
  assert.equal(res.json.handoverCode, job.pickup_otp, 'the code he reads to the operator');
  assert.equal(res.json.cashToCollect, 510, 'goods plus the fee, in cash');
  assert.equal(res.json.goodsAmount, 450);
  assert.equal(res.json.buyerName, 'Farmer');

  const late = await accept(b, job.id);
  assert.equal(late.status, 409);
  assert.match(errorText(late), /Another partner already took this job/);
  assert.equal((await offersOf(b)).length, 0, 'his offer is gone');
  assert.deepEqual((await call('GET', '/v1/delivery/jobs/active', { device: a })).json.map((j) => j.id), [job.id]);

  const buyer = (await alerts('buyer-accept')).find((n) => n.title === 'A delivery partner is on the way to the center');
  assert.match(buyer.body, /Partner a \(Pickup \/ small van, MH12ZZ\d+\)/);
  const operator = (await alerts(c.device)).find((n) => n.title === 'A delivery partner is coming for an order');
  assert.match(operator.body, /handover code/);
});

test('several partners pressing Accept at once: exactly one gets it', async () => {
  const c = await makeCenter('race', nextZone());
  const ps = [await makePartner('r1', c, { dLat: 0.01 }), await makePartner('r2', c, { dLat: 0.02 }), await makePartner('r3', c, { dLat: 0.03 })];
  const job = await jobOf((await orderDelivery(c, 'race-buyer')).json.id);
  const results = await Promise.all(ps.map((p) => accept(p, job.id)));
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 409));
  const after = await jobOf((await db.query('SELECT order_id FROM delivery_job WHERE id = $1', [job.id])).rows[0].order_id);
  assert.equal(after.status, 'assigned');
  assert.ok(ps.includes(after.partner_id));
});

test('a job that was not offered to you, or has gone, cannot be taken', async () => {
  const c = await makeCenter('notyours', nextZone());
  const p = await makePartner('mine', c);
  const outsider = await makePartner('outsider', c, { dLat: 0.02, capacityKg: 100 }); // too small for 40 kg? no: 100 >= 40, so offered
  const stranger = 'not-a-partner-at-all';
  const job = await jobOf((await orderDelivery(c, 'notyours-buyer')).json.id);
  assert.equal((await accept(stranger, job.id)).status, 404);
  assert.equal((await accept(p, 'job-nope')).status, 404);
  assert.equal((await call('GET', `/v1/delivery/jobs/${job.id}`, { device: stranger })).status, 404);
  assert.ok(outsider);
});

test('declining an offer is final for that partner, and asks the next partners once every offer is answered', async () => {
  const c = await makeCenter('decline', nextZone());
  const ps = [];
  for (let i = 1; i <= 5; i += 1) ps.push(await makePartner(`d${i}`, c, { dLat: 0.01 * i }));
  const job = await jobOf((await orderDelivery(c, 'decline-buyer')).json.id);
  assert.deepEqual(await offered(job.id), ps.slice(0, 3).sort());

  assert.equal((await decline(ps[0], job.id)).status, 204);
  assert.equal((await decline(ps[0], job.id)).status, 409, 'already answered');
  assert.deepEqual(await offered(job.id), ps.slice(0, 3).sort(), 'two offers are still open, so nobody new yet');
  await decline(ps[1], job.id);
  await decline(ps[2], job.id);
  assert.deepEqual(await offered(job.id), ps.slice(0, 5).sort(), 'the last open offer was answered: the next two are asked');
  assert.equal((await offersOf(ps[3])).length, 1);
  assert.equal((await decline('nobody', job.id)).status, 404);
  assert.equal((await accept(ps[0], job.id)).status, 409, 'and the one who declined cannot change his mind');
});

test('an offer nobody answers runs out, and the next partners are asked on the next pass', async () => {
  const c = await makeCenter('expire', nextZone());
  const ps = [];
  for (let i = 1; i <= 4; i += 1) ps.push(await makePartner(`e${i}`, c, { dLat: 0.01 * i }));
  const job = await jobOf((await orderDelivery(c, 'expire-buyer')).json.id);
  assert.deepEqual(await offered(job.id), ps.slice(0, 3).sort());

  assert.equal((await tick(1)).offered, 0, 'still inside the window');
  const r = await tick(5);
  assert.ok(r.expired >= 3);
  assert.deepEqual(await offered(job.id), ps.sort(), 'the fourth was asked once the first three ran out');
  assert.equal((await accept(ps[0], job.id)).status, 409);
  assert.match(errorText(await accept(ps[0], job.id)), /run out|no longer|already/i);
});

test('with nobody free the operator is asked to step in once, and a partner who comes online later is offered it', async () => {
  const c = await makeCenter('nobody', nextZone());
  const order = (await orderDelivery(c, 'nobody-buyer')).json;
  const job = await jobOf(order.id);
  assert.equal(job.status, 'open');
  const askedOnce = async () => (await alerts(c.device)).filter((n) => n.title === 'A delivery needs a driver');
  assert.equal((await askedOnce()).length, 1);
  assert.match((await askedOnce())[0].body, /assign someone yourself/);
  await tick(1);
  await tick(2);
  assert.equal((await askedOnce()).length, 1, 'not on every pass');

  const late = await makePartner('late', c);
  assert.equal((await offersOf(late)).length, 0, 'not offered until the next pass');
  assert.equal((await tick(3)).offered, 1);
  assert.equal((await offersOf(late)).length, 1);
});

test('nobody in time: the order falls back to plain pickup, with a code, no fee, and everyone told', async () => {
  const c = await makeCenter('fallback', nextZone());
  const order = (await orderDelivery(c, 'fallback-buyer')).json;
  const job = await jobOf(order.id);

  const r = await tick(46); // the pass looks at every open job, not just this one
  assert.ok(r.fellBack >= 1);
  const after = await jobOf(order.id);
  assert.equal(after.status, 'fallback');
  assert.match(after.cancelled_reason, /No delivery partner was free in time/);

  const seen = (await call('GET', `/v1/orders/${order.id}`, { device: 'fallback-buyer' })).json;
  assert.equal(seen.fulfilment, 'pickup');
  assert.equal(seen.deliveryFee, 0);
  assert.equal(seen.payableAmount, 450);
  assert.match(seen.pickupOtp, /^\d{4}$/, 'a code to collect it at the center');
  assert.equal(seen.status, 'pending', 'the order itself is untouched');

  const told = (await alerts('fallback-buyer')).find((n) => n.title === 'No delivery partner was free');
  assert.match(told.body, /collect your order at Center fallback/);
  assert.ok(told.body.includes(seen.pickupOtp));
  assert.match(told.body, /not be charged the delivery fee/);
  assert.ok((await alerts(c.device)).some((n) => n.title === 'Delivery fell back to pickup'));
  assert.equal((await tick(47)).fellBack, 0, 'and it does not happen twice');

  // The plain counter flow works again for this order.
  await call('POST', `/v1/operator/orders/${order.id}/ready`, { device: c.device });
  const done = await call('POST', `/v1/operator/orders/${order.id}/verify-otp`, { device: c.device, body: { otp: seen.pickupOtp } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.status, 'completed');
  assert.ok(job.id);
});

// ---------------------------------------------------------------------------
// Things that end or change a delivery
// ---------------------------------------------------------------------------

test('cancelling the order ends its delivery, and tells the partner not to go', async () => {
  const c = await makeCenter('cancel', nextZone());
  const p = await makePartner('cx', c);
  const order = (await orderDelivery(c, 'cancel-buyer')).json;
  const job = await jobOf(order.id);
  await accept(p, job.id);

  const res = await call('POST', `/v1/orders/${order.id}/cancel`, { device: 'cancel-buyer' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal((await jobOf(order.id)).status, 'cancelled');
  assert.equal((await call('GET', '/v1/delivery/jobs/active', { device: p })).json.length, 0);
  const told = (await alerts(p)).find((n) => n.title === 'A delivery was cancelled');
  assert.match(told.body, /The order was cancelled/);
  assert.equal((await db.query('SELECT reserved FROM center_inventory WHERE center_id = $1 AND product_id = $2', [c.centerId, 'p-vermicompost'])).rows[0].reserved, 0, 'the stock is back');
});

test('an order whose reservation expires ends its delivery too', async () => {
  const c = await makeCenter('expires', nextZone());
  const order = (await orderDelivery(c, 'expiry-buyer')).json;
  const { runReservationMaintenance } = require('../src/services/reservationJobs');
  for (let i = 0; i < 50; i += 1) {
    const r = await runReservationMaintenance(db, new Date(Date.now() + 6 * 24 * 3600 * 1000));
    if (!r.skipped) break;
    await new Promise((res) => setTimeout(res, 40));
  }
  assert.equal((await jobOf(order.id)).status, 'cancelled');
  assert.equal((await call('GET', `/v1/orders/${order.id}`, { device: 'expiry-buyer' })).json.status, 'cancelled');
});

test('a partner who hands a job back before collecting it: it goes out again, to others, and it counts against him', async () => {
  const c = await makeCenter('release', nextZone());
  const a = await makePartner('ra', c, { dLat: 0.01 });
  const b = await makePartner('rb', c, { dLat: 0.02 });
  const order = (await orderDelivery(c, 'release-buyer')).json;
  const job = await jobOf(order.id);
  await accept(a, job.id);
  assert.equal((await offersOf(b)).length, 0);

  assert.equal((await decline(a, job.id)).status, 204);
  const after = await jobOf(order.id);
  assert.equal(after.status, 'open');
  assert.equal(after.partner_id, null);
  assert.equal((await db.query('SELECT cancellations FROM delivery_partner WHERE user_id = $1', [a])).rows[0].cancellations, 1);
  assert.equal((await offersOf(a)).length, 0, 'not offered again to the one who dropped it');
  assert.equal((await offersOf(b)).length, 1, 'the next partner is asked at once');
  assert.ok((await alerts('release-buyer')).some((n) => n.title === 'Your delivery partner had to drop out'));
});

test('a delivery order is not moved to another center when its center closes', async () => {
  const z = nextZone();
  const c = await makeCenter('stay', z);
  await makeCenter('stay-backup', z + 0.01);
  const order = (await orderDelivery(c, 'stay-buyer')).json;
  await call('PATCH', '/v1/operator/center', { device: c.device, body: { isOpen: false } });
  for (let i = 0; i < 50; i += 1) {
    const r = await runReassignment(db, { now: minutesFromNow(60) });
    if (!r.skipped) break;
    await new Promise((res) => setTimeout(res, 40));
  }
  assert.equal((await db.query('SELECT center_id FROM orders WHERE id = $1', [order.id])).rows[0].center_id, c.centerId);
});

test('the counter code cannot be used for a delivery order', async () => {
  const c = await makeCenter('nocounter', nextZone());
  const order = (await orderDelivery(c, 'nocounter-buyer')).json;
  await call('POST', `/v1/operator/orders/${order.id}/ready`, { device: c.device });
  const res = await call('POST', `/v1/operator/orders/${order.id}/verify-otp`, { device: c.device, body: { otp: '0000' } });
  assert.equal(res.status, 409);
  assert.match(errorText(res), /home delivery/);
});

test('sharing a location is for approved partners, and needs real coordinates', async () => {
  const c = await makeCenter('loc', nextZone());
  const ok = await makePartner('loc', c);
  const pending = await makePartner('locp', c, { approve: false });
  assert.equal((await call('PUT', '/v1/delivery/partner/location', { device: ok, body: { latitude: c.latitude, longitude: c.longitude } })).status, 204);
  assert.equal((await call('PUT', '/v1/delivery/partner/location', { device: pending, body: { latitude: c.latitude, longitude: c.longitude } })).status, 403);
  assert.equal((await call('PUT', '/v1/delivery/partner/location', { device: 'never-applied', body: { latitude: 1, longitude: 1 } })).status, 403);
  assert.equal((await call('PUT', '/v1/delivery/partner/location', { device: ok, body: { latitude: 95, longitude: 0 } })).status, 400);
  assert.equal((await call('PUT', '/v1/delivery/partner/location', { device: ok, body: { latitude: 5 } })).status, 400);
});
