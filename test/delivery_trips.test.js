process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.RATE_LIMIT_OTP = '100000';
// One offer at a time makes "who was asked first" visible.
process.env.DELIVERY_OFFERS_PER_ROUND = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

// Batching several jobs on one vehicle, trips ("I am going there tomorrow"), and
// farmer-to-farmer carriage.
let server;
let base;
let db;
let counter = 0;
let testImage;
let runDispatch;
let trips;
let centerTz;

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

let plate = 6000;
const makePartner = async (name, center, o = {}) => {
  const { vehicleType = 'pickup', capacityKg = 100, dLat = 0.01, online = true, approve = true } = o;
  const device = `pt-${name}-${counter += 1}`;
  await call('PUT', '/v1/farmer/profile', { device, body: { name: `Partner ${name}`, village: 'Shirur' } });
  const saved = await call('PUT', '/v1/delivery/partner', {
    device, body: { vehicleType, vehicleNumber: `MH12ZZ${(plate += 1)}`, capacityKg, phone: '9876500000', maxDistanceKm: 10, freeFrom: '00:00', freeUntil: '23:59', reviewCenterId: center.centerId },
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
const orderDelivery = (c, device, addr = {}) =>
  call('POST', '/v1/orders', {
    device, body: { centerId: c.centerId, items: [{ productId: 'p-vermicompost', quantity: 1 }], fulfilment: 'delivery', deliveryAddress: address(c, addr) },
  });
const jobOf = async (orderId) => (await db.query('SELECT * FROM delivery_job WHERE order_id = $1', [orderId])).rows[0];
const jobById = async (id) => (await db.query('SELECT * FROM delivery_job WHERE id = $1', [id])).rows[0];
const alerts = async (device) => (await call('GET', '/v1/farmer/notifications', { device })).json.filter((n) => n.type === 'delivery');
const offersOf = async (device) => (await call('GET', '/v1/delivery/jobs/offers', { device })).json;
const accept = (device, jobId) => call('POST', `/v1/delivery/jobs/${jobId}/accept`, { device });
const deliver = (device, jobId, otp) => call('POST', `/v1/delivery/jobs/${jobId}/deliver`, { device, body: { otp } });
const wrongCode = (real) => (real === '0000' ? '1111' : '0000');
const today = () => trips.localDate(new Date(), centerTz);
const inDays = (n) => trips.addDays(today(), n);

test.before(async () => {
  const { openTestDb, testImage: image } = require('./helpers');
  const { createApp } = require('../src/app');
  testImage = image;
  ({ runDeliveryDispatch: runDispatch } = require('../src/services/deliveryJobs'));
  trips = require('../src/services/deliveryTrips');
  centerTz = require('../src/config').centerTimezone;
  db = await openTestDb('t_delivery_trips');
  const app = createApp(db);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

// ---------------------------------------------------------------------------
// Batching: one vehicle, several farms
// ---------------------------------------------------------------------------

test('a partner can carry two orders together, and a third that does not fit is refused', async () => {
  const c = await makeCenter('batch', nextZone());
  const ramesh = await makePartner('ramesh', c, { capacityKg: 100 }); // two 40 kg orders fit, three do not
  const a = (await orderDelivery(c, 'buyer-b1')).json;
  const b = (await orderDelivery(c, 'buyer-b2', { latitude: c.latitude + 0.046 })).json;
  const c3 = (await orderDelivery(c, 'buyer-b3', { latitude: c.latitude + 0.047 })).json;
  const [ja, jb, jc] = await Promise.all([jobOf(a.id), jobOf(b.id), jobOf(c3.id)]);

  assert.equal((await accept(ramesh, ja.id)).status, 200);
  const second = await accept(ramesh, jb.id);
  assert.equal(second.status, 200, JSON.stringify(second.json));
  const third = await accept(ramesh, jc.id);
  assert.equal(third.status, 409);
  assert.match(errorText(third), /does not fit/);

  const active = (await call('GET', '/v1/delivery/jobs/active', { device: ramesh })).json;
  assert.equal(active.length, 2, 'both jobs are on his trip');
  assert.ok(active.every((j) => /^\d{4}$/.test(j.handoverCode)), 'each order has its own handover code');
});

test('a partner who already has a job going the same way is asked first for the next one', async () => {
  const c = await makeCenter('ride', nextZone());
  const going = await makePartner('going', c, { capacityKg: 200, dLat: 0.02 });   // farther from the center
  const nearer = await makePartner('nearer', c, { capacityKg: 200, dLat: 0.001 }); // right next to it

  // Only 'going' is asked for the first order (make 'nearer' unavailable for a moment).
  await call('PUT', '/v1/delivery/partner/online', { device: nearer, body: { online: false } });
  const first = (await orderDelivery(c, 'buyer-r1')).json;
  assert.equal((await accept(going, (await jobOf(first.id)).id)).status, 200);
  await call('PUT', '/v1/delivery/partner/online', { device: nearer, body: { online: true } });

  // A second order the same way: the nearer partner would win on distance, but the
  // one already going that way is offered it first (offers go one at a time here).
  const second = (await orderDelivery(c, 'buyer-r2', { latitude: c.latitude + 0.046 })).json;
  const job = await jobOf(second.id);
  assert.equal((await offersOf(going)).some((o) => o.id === job.id), true, 'the batching partner was asked');
  assert.equal((await offersOf(nearer)).some((o) => o.id === job.id), false, 'the nearer one was not asked first');
  assert.ok((await alerts(going)).some((n) => /same way/i.test(n.body)));
});

test('accepting a job offers the partner other open jobs along the same road', async () => {
  const c = await makeCenter('along', nextZone());
  // Nobody is free at first, so both orders stay open.
  const one = (await orderDelivery(c, 'buyer-a1')).json;
  const two = (await orderDelivery(c, 'buyer-a2', { latitude: c.latitude + 0.046 })).json;
  const [j1, j2] = [await jobOf(one.id), await jobOf(two.id)];
  assert.equal(j2.status, 'open');

  const ramesh = await makePartner('ramesh-along', c, { capacityKg: 200 });
  // He was asked for the first one by the dispatcher; the second is only offered along with it.
  await runDispatch(db, { now: new Date() });
  const offers = await offersOf(ramesh);
  assert.ok(offers.some((o) => o.id === j1.id || o.id === j2.id));
  const target = offers[0].id;
  assert.equal((await accept(ramesh, target)).status, 200);
  const other = target === j1.id ? j2.id : j1.id;
  assert.equal((await offersOf(ramesh)).some((o) => o.id === other), true, 'the other one is now offered along the way');
});

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

const tripBody = (c, extra = {}) => ({
  from: { latitude: c.latitude + 0.01, longitude: c.longitude, label: 'Shirur' },
  to: { latitude: c.latitude + 0.06, longitude: c.longitude, label: 'Talegaon' },
  date: today(), spareKg: 60, note: 'Going to the market', ...extra,
});

test('only an approved partner can post a trip, and the checks are enforced', async () => {
  const c = await makeCenter('tripcheck', nextZone());
  const pending = await makePartner('pending', c, { approve: false });
  assert.equal((await call('POST', '/v1/delivery/trips', { device: pending, body: tripBody(c) })).status, 403);
  assert.equal((await call('POST', '/v1/delivery/trips', { device: 'plain-farmer', body: tripBody(c) })).status, 403);

  const p = await makePartner('tripper', c, { capacityKg: 100 });
  const bad = async (extra, pattern) => {
    const r = await call('POST', '/v1/delivery/trips', { device: p, body: tripBody(c, extra) });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(errorText(r), pattern);
  };
  await bad({ date: inDays(-1) }, /already passed/);
  await bad({ date: inDays(30) }, /days ahead/);
  await bad({ date: 'tomorrow' }, /must be a day/);
  await bad({ date: '2026-02-31' }, /must be a day/);
  await bad({ spareKg: 500 }, /between 1 and 100/);
  await bad({ spareKg: 0 }, /between 1 and 100/);
  await bad({ to: { latitude: c.latitude + 0.01, longitude: c.longitude } }, /same/);
  await bad({ from: { latitude: 200, longitude: 0 } }, /latitude/);

  const ok = await call('POST', '/v1/delivery/trips', { device: p, body: tripBody(c, { date: inDays(1) }) });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.leftKg, 60);
  const mine = (await call('GET', '/v1/delivery/trips', { device: p })).json;
  assert.equal(mine.length, 1);
  assert.equal((await call('DELETE', `/v1/delivery/trips/${ok.json.id}`, { device: 'someone-else' })).status, 404);
  assert.equal((await call('DELETE', `/v1/delivery/trips/${ok.json.id}`, { device: p })).status, 204);
  assert.equal((await call('GET', '/v1/delivery/trips', { device: p })).json.length, 0);
});

test('the board shows trips that start near me, with room, and not my own', async () => {
  const c = await makeCenter('board', nextZone());
  const p = await makePartner('boarder', c, { capacityKg: 100 });
  const created = (await call('POST', '/v1/delivery/trips', { device: p, body: tripBody(c, { date: inDays(1), spareKg: 50 }) })).json;

  const near = { latitude: c.latitude + 0.012, longitude: c.longitude };
  const seen = (await call('GET', `/v1/delivery/trips/board?latitude=${near.latitude}&longitude=${near.longitude}`, { device: 'someone' })).json;
  const row = seen.find((t) => t.id === created.id);
  assert.ok(row, 'visible to a farmer nearby');
  assert.equal(row.leftKg, 50);
  assert.equal(row.partnerName, 'Partner boarder');
  assert.equal(row.vehicleType, 'pickup');

  const heavy = (await call('GET', `/v1/delivery/trips/board?latitude=${near.latitude}&longitude=${near.longitude}&weightKg=80`, { device: 'someone' })).json;
  assert.equal(heavy.some((t) => t.id === created.id), false, 'not enough room for 80 kg');
  const far = (await call('GET', `/v1/delivery/trips/board?latitude=${near.latitude + 3}&longitude=${near.longitude}`, { device: 'someone' })).json;
  assert.equal(far.some((t) => t.id === created.id), false, 'too far from me');
  const own = (await call('GET', `/v1/delivery/trips/board?latitude=${near.latitude}&longitude=${near.longitude}`, { device: p })).json;
  assert.equal(own.some((t) => t.id === created.id), false, 'my own trip is not on my board');
});

test('an order along a partner\'s trip today is offered to him even when he is not "free now"', async () => {
  const c = await makeCenter('tripjob', nextZone());
  // Off duty, but going that way today.
  const tripper = await makePartner('tripper2', c, { capacityKg: 100, online: false });
  const idle = await makePartner('idle', c, { capacityKg: 100, online: false });
  await call('POST', '/v1/delivery/trips', {
    device: tripper,
    body: tripBody(c, { from: { latitude: c.latitude + 0.005, longitude: c.longitude, label: 'By the center' }, to: { latitude: c.latitude + 0.05, longitude: c.longitude, label: 'The farm road' } }),
  });
  const order = (await orderDelivery(c, 'buyer-trip')).json;
  const job = await jobOf(order.id);
  assert.equal((await offersOf(tripper)).some((o) => o.id === job.id), true);
  assert.equal((await offersOf(idle)).length, 0, 'an off-duty partner with no trip is not asked');
  assert.ok((await alerts(tripper)).some((n) => /along your trip/i.test(n.body)));
  assert.equal((await accept(tripper, job.id)).status, 200);
});

test('booking room on a trip: the trip owner is asked first and the room is used up', async () => {
  const c = await makeCenter('book', nextZone());
  const owner = await makePartner('owner', c, { capacityKg: 100, dLat: 0.01 });
  const other = await makePartner('other', c, { capacityKg: 100, dLat: 0.012 });
  const trip = (await call('POST', '/v1/delivery/trips', { device: owner, body: tripBody(c, { date: inDays(1), spareKg: 60 }) })).json;

  const load = (extra = {}) => ({
    tripId: trip.id, weightKg: 40, description: 'Ten bags of wheat seed',
    from: { latitude: c.latitude + 0.011, longitude: c.longitude, label: 'My farm', phone: '9822012345' },
    to: { latitude: c.latitude + 0.055, longitude: c.longitude, label: 'Uncle\'s farm', village: 'Talegaon', phone: '9822054321' },
    ...extra,
  });
  const booked = await call('POST', '/v1/delivery/p2p', { device: 'sender-book', body: load() });
  assert.equal(booked.status, 201, JSON.stringify(booked.json));
  assert.equal(booked.json.kind, 'p2p');
  assert.equal(booked.json.status, 'open');
  assert.equal(booked.json.tripId, trip.id);

  // Only the trip owner is asked, and his offer waits until the trip day is over.
  assert.equal((await offersOf(owner)).some((o) => o.id === booked.json.jobId), true);
  assert.equal((await offersOf(other)).length, 0, 'the general pool is not asked while the trip owner is deciding');
  await runDispatch(db, { now: new Date() });
  assert.equal((await offersOf(other)).length, 0);

  // 20 kg of room is left: a 40 kg booking does not fit, a 15 kg one does.
  const tooBig = await call('POST', '/v1/delivery/p2p', { device: 'sender-book2', body: load({ weightKg: 40 }) });
  assert.equal(tooBig.status, 409);
  assert.match(errorText(tooBig), /room for 20 kg more/);
  assert.equal((await call('POST', '/v1/delivery/p2p', { device: 'sender-book2', body: load({ weightKg: 15 }) })).status, 201);
  assert.equal((await call('GET', '/v1/delivery/trips', { device: owner })).json[0].leftKg, 5);

  // A trip that does not pass near the places is refused; so is booking one's own trip.
  const offRoute = await call('POST', '/v1/delivery/p2p', { device: 'sender-book3', body: load({ weightKg: 1, to: { latitude: c.latitude + 0.14, longitude: c.longitude, phone: "9822054321" } }) });
  assert.equal(offRoute.status, 409);
  assert.match(errorText(offRoute), /close enough/);
  assert.equal((await call('POST', '/v1/delivery/p2p', { device: owner, body: load({ weightKg: 1 }) })).status, 409);

  // Cancelling a trip with a booking not yet accepted puts it back in the pool.
  assert.equal((await call('DELETE', `/v1/delivery/trips/${trip.id}`, { device: owner })).status, 204);
  const after = await jobById(booked.json.jobId);
  assert.equal(after.trip_id, null);
  assert.equal((await offersOf(other)).some((o) => o.id === booked.json.jobId), true, 'now the others are asked');
  assert.ok((await alerts('sender-book')).some((n) => /called off/i.test(n.title)));
});

test('a trip with an accepted booking cannot be cancelled', async () => {
  const c = await makeCenter('tripkeep', nextZone());
  const owner = await makePartner('keeper', c, { capacityKg: 100 });
  const trip = (await call('POST', '/v1/delivery/trips', { device: owner, body: tripBody(c, { spareKg: 60 }) })).json;
  const booked = (await call('POST', '/v1/delivery/p2p', {
    device: 'sender-keep',
    body: {
      tripId: trip.id, weightKg: 10, description: 'A can of pesticide',
      from: { latitude: c.latitude + 0.011, longitude: c.longitude, phone: '9822012345' },
      to: { latitude: c.latitude + 0.055, longitude: c.longitude, phone: '9822054321' },
    },
  })).json;
  assert.equal((await accept(owner, booked.jobId)).status, 200);
  const r = await call('DELETE', `/v1/delivery/trips/${trip.id}`, { device: owner });
  assert.equal(r.status, 409);
  assert.match(errorText(r), /already accepted/);
});

// ---------------------------------------------------------------------------
// Farmer to farmer
// ---------------------------------------------------------------------------

const p2pBody = (c, extra = {}) => ({
  weightKg: 30, description: 'Two sacks of seed potatoes', feePayer: 'sender',
  from: { latitude: c.latitude + 0.011, longitude: c.longitude, label: 'My farm', phone: '98220 12345' },
  to: { latitude: c.latitude + 0.05, longitude: c.longitude, label: 'Uncle\'s farm', village: 'Talegaon', phone: '98220 54321', note: 'Blue gate' },
  ...extra,
});

test('farmer to farmer, start to finish: the sender types the handover code, the receiver gives the drop code', async () => {
  const c = await makeCenter('p2p', nextZone());
  const ramesh = await makePartner('ramesh-p2p', c, { capacityKg: 100 });
  const sender = 'sender-p2p';

  const q = await call('POST', '/v1/delivery/p2p/quote', { device: sender, body: p2pBody(c) });
  assert.equal(q.status, 200, JSON.stringify(q.json));
  assert.equal(q.json.available, true);
  assert.ok(q.json.fee >= 30);
  assert.equal(q.json.partnersFree, 1);

  const placed = await call('POST', '/v1/delivery/p2p', { device: sender, body: p2pBody(c) });
  assert.equal(placed.status, 201, JSON.stringify(placed.json));
  assert.equal(placed.json.fee, q.json.fee, 'the price quoted is the price charged');
  assert.equal(placed.json.description, 'Two sacks of seed potatoes');
  assert.equal(placed.json.dropCode, null, 'nobody is coming yet');
  const jobId = placed.json.jobId;

  // He sees the job with the money and the rough place, not the exact spots.
  const offer = (await offersOf(ramesh)).find((o) => o.id === jobId);
  assert.ok(offer);
  assert.equal(offer.kind, 'p2p');
  assert.equal(offer.items, 'Two sacks of seed potatoes');
  assert.equal(offer.drop.latitude, undefined);
  const mine = (await accept(ramesh, jobId)).json;
  assert.equal(mine.status, 'assigned');
  assert.equal(mine.pickup.phone, '9822012345', 'he can call the sender');
  assert.equal(mine.drop.phone, '9822054321', 'and the receiver');
  assert.equal(mine.collectFeeFrom, 'sender');
  assert.equal(mine.cashToCollect, q.json.fee);
  assert.match(mine.handoverCode, /^\d{4}$/);

  // The sender sees the drop code (to give the receiver), never the handover code.
  const seen = (await call('GET', `/v1/delivery/p2p/${jobId}`, { device: sender })).json;
  assert.equal(seen.status, 'assigned');
  assert.equal(seen.partner.name, 'Partner ramesh-p2p');
  assert.match(seen.dropCode, /^\d{4}$/);
  assert.equal(JSON.stringify(seen).includes(mine.handoverCode) && mine.handoverCode !== seen.dropCode, false, 'the handover code is not in the sender\'s view');
  assert.equal(seen.canCancel, true);
  assert.equal((await call('GET', `/v1/delivery/p2p/${jobId}`, { device: 'a-stranger' })).status, 404);

  // Delivering before the handover is refused.
  assert.equal((await deliver(ramesh, jobId, seen.dropCode)).status, 409);

  // A wrong handover code is counted; the right one starts the trip.
  const wrong = await call('POST', `/v1/delivery/p2p/${jobId}/handover`, { device: sender, body: { otp: wrongCode(mine.handoverCode) } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.attemptsLeft, 4);
  assert.equal((await call('POST', `/v1/delivery/p2p/${jobId}/handover`, { device: 'a-stranger', body: { otp: mine.handoverCode } })).status, 404);
  const handed = await call('POST', `/v1/delivery/p2p/${jobId}/handover`, { device: sender, body: { otp: mine.handoverCode } });
  assert.equal(handed.status, 200, JSON.stringify(handed.json));
  assert.equal(handed.json.status, 'in_transit');
  assert.equal(handed.json.canCancel, false);
  assert.equal((await call('POST', `/v1/delivery/p2p/${jobId}/cancel`, { device: sender })).status, 409, 'on the road: too late to cancel');

  // The receiver gives the drop code; the partner is paid.
  assert.equal((await deliver(ramesh, jobId, wrongCode(seen.dropCode))).status, 400);
  const done = await deliver(ramesh, jobId, seen.dropCode);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.status, 'delivered');

  const wallet = (await call('GET', '/v1/delivery/wallet', { device: ramesh })).json;
  assert.equal(wallet.earned, q.json.fee);
  assert.equal(wallet.owed, 0, 'no center, no goods money to hand over');
  assert.equal(wallet.deliveriesDone, 1);
  assert.deepEqual(wallet.entries.map((e) => e.kind), ['fee_earned']);

  // Both sides rate, once.
  assert.equal((await call('POST', `/v1/delivery/p2p/${jobId}/rate`, { device: sender, body: { stars: 5 } })).status, 204);
  assert.equal((await call('POST', `/v1/delivery/p2p/${jobId}/rate`, { device: sender, body: { stars: 4 } })).status, 409);
  assert.equal((await call('POST', `/v1/delivery/jobs/${jobId}/rate-buyer`, { device: ramesh, body: { stars: 5 } })).status, 204);
  assert.equal((await call('GET', '/v1/delivery/partner', { device: ramesh })).json.ratingAvg, 5);
  assert.ok((await alerts(sender)).some((n) => n.title === 'Delivered'));
});

test('farmer to farmer: validation, limits, cancelling, and nobody free', async () => {
  const c = await makeCenter('p2pedge', nextZone());
  const ramesh = await makePartner('ramesh-edge', c, { capacityKg: 100 });
  const sender = 'sender-edge';
  const bad = async (extra, status, pattern) => {
    const r = await call('POST', '/v1/delivery/p2p', { device: sender, body: p2pBody(c, extra) });
    assert.equal(r.status, status, JSON.stringify(r.json));
    assert.match(errorText(r), pattern);
  };
  await bad({ weightKg: 0 }, 400, /weightKg/);
  await bad({ weightKg: 99999 }, 400, /weightKg/);
  await bad({ weightKg: '30' }, 400, /weightKg/);
  await bad({ description: ' ' }, 400, /what is being carried/i);
  await bad({ feePayer: 'nobody' }, 400, /feePayer/);
  await bad({ to: { latitude: c.latitude + 1, longitude: c.longitude, phone: '9822054321' } }, 400, /up to 20 km/);
  await bad({ to: { latitude: c.latitude + 0.011, longitude: c.longitude, phone: '9822054321' } }, 400, /same/);
  await bad({ to: { latitude: c.latitude + 0.05, longitude: c.longitude, phone: 'abc' } }, 400, /phone/i);
  await bad({ tripId: 'trip-missing' }, 404, /not available/);

  // A partner cannot carry his own request.
  const own = await call('POST', '/v1/delivery/p2p', { device: ramesh, body: p2pBody(c) });
  assert.equal(own.status, 201);
  assert.equal((await offersOf(ramesh)).some((o) => o.id === own.json.jobId), false);
  await call('POST', `/v1/delivery/p2p/${own.json.jobId}/cancel`, { device: ramesh });

  // Cancel before anyone accepts, and after: the partner is told not to go.
  const one = (await call('POST', '/v1/delivery/p2p', { device: sender, body: p2pBody(c) })).json;
  const cancelled = await call('POST', `/v1/delivery/p2p/${one.jobId}/cancel`, { device: sender });
  assert.equal(cancelled.json.status, 'cancelled');
  assert.equal((await accept(ramesh, one.jobId)).status, 409);
  const two = (await call('POST', '/v1/delivery/p2p', { device: sender, body: p2pBody(c) })).json;
  assert.equal((await accept(ramesh, two.jobId)).status, 200);
  assert.equal((await call('POST', `/v1/delivery/p2p/${two.jobId}/cancel`, { device: sender })).json.status, 'cancelled');
  assert.ok((await alerts(ramesh)).some((n) => /cancelled/i.test(n.title)));

  // Only so many requests at once.
  const spam = 'sender-spam';
  for (let i = 0; i < 5; i += 1) assert.equal((await call('POST', '/v1/delivery/p2p', { device: spam, body: p2pBody(c) })).status, 201);
  const sixth = await call('POST', '/v1/delivery/p2p', { device: spam, body: p2pBody(c) });
  assert.equal(sixth.status, 409);
  assert.match(errorText(sixth), /5 requests/);
});

test('farmer to farmer with nobody free: the sender is told, and it ends', async () => {
  const c = await makeCenter('p2pnone', nextZone());
  const sender = 'sender-none';
  const placed = (await call('POST', '/v1/delivery/p2p', { device: sender, body: p2pBody(c) })).json;
  assert.equal(placed.status, 'open');
  await runDispatch(db, { now: new Date() });
  assert.ok((await alerts(sender)).some((n) => /No delivery partner is free yet/.test(n.title)), 'told once that we are still looking');

  const later = new Date(Date.now() + 60 * 60 * 1000);
  await runDispatch(db, { now: later });
  const after = (await call('GET', `/v1/delivery/p2p/${placed.jobId}`, { device: sender })).json;
  assert.equal(after.status, 'fallback');
  assert.ok((await alerts(sender)).some((n) => /No delivery partner was free/.test(n.title)));
  assert.equal((await call('GET', '/v1/delivery/p2p', { device: sender })).json.length, 1);
});
