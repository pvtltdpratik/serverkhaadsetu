process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stock reservations, automatic center assignment, walk-in deduction and the
// expiry/reminder job (anonymous X-Device-Id mode). Centers sit on a
// north-south line at longitude 74.0; the farmer stands at BASE.
const BASE = { latitude: 18.5, longitude: 74.0 };
const DAY = 24 * 60 * 60 * 1000;

let server;
let base;
let db;
let runMaintenance;
let runMaintenanceRaw;
const centers = {};

const call = async (method, path, { body, device = 'farmer-1' } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-device-id': device },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

let counter = 0;
// Each test that relies on automatic assignment works in its own zone, 111 km
// (one degree of latitude) from every other, so centers left over from earlier
// tests can never be candidates.
const zoneBase = (zone) => ({ latitude: BASE.latitude + zone, longitude: BASE.longitude });
const makeCenter = async (key, dLat, zone = 0) => {
  counter += 1;
  const op = `op-${key}-${counter}`;
  await call('GET', '/v1/me', { device: op });
  const res = await call('POST', '/v1/admin/centers', {
    device: 'admin',
    body: { name: `Center ${key}`, village: key, latitude: BASE.latitude + zone + dLat, longitude: BASE.longitude, operatorId: op, opensAt: '00:00', closesAt: '23:59' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { ...res.json, device: op };
};
const stock = (c, productId, quantity) => call('POST', '/v1/operator/inventory/receive', { device: c.device, body: { productId, quantity } });
const shelf = async (c, productId) => (await db.query('SELECT on_hand, reserved FROM center_inventory WHERE center_id = $1 AND product_id = $2', [c.centerId, productId])).rows[0];
const order = (body, device = 'farmer-1') => call('POST', '/v1/orders', { device, body });
const cart = (productId, quantity) => [{ productId, quantity }];
const titles = async (device) => (await call('GET', '/v1/farmer/notifications', { device })).json.map((n) => n.title);

test.before(async () => {
  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  ({ runReservationMaintenance: runMaintenanceRaw } = require('../src/services/reservationJobs'));
  // The job's lock is database-wide and test files run in parallel, so another file's run
  // can make ours skip. Most tests just want the job to have run: retry until it does.
  runMaintenance = async (d, now) => {
    for (let i = 0; i < 100; i += 1) {
      const r = await runMaintenanceRaw(d, now);
      if (!r.skipped) return r;
      await new Promise((res) => setTimeout(res, 40));
    }
    throw new Error('the reservation job never got its lock');
  };
  db = await openTestDb('t_reservations');
  const app = createApp(db);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

test('placing an order holds stock, tells the farmer where to go, and alerts the operator', async () => {
  const a = await makeCenter('hold', 0.02);
  await stock(a, 'p-neemcake', 10);
  const placed = await order({ ...BASE, items: cart('p-neemcake', 3) });
  assert.equal(placed.status, 201, JSON.stringify(placed.json));
  assert.equal(placed.json.centerId, a.centerId);
  assert.equal(placed.json.center.name, 'Center hold');
  assert.equal(placed.json.status, 'pending');
  assert.equal(placed.json.items[0].productId, 'p-neemcake');
  assert.ok(!('stockReserved' in placed.json), 'internal flag is not exposed');
  const days = (new Date(placed.json.reservedUntil) - new Date(placed.json.createdAt)) / DAY;
  assert.equal(days, 5);

  assert.deepEqual(await shelf(a, 'p-neemcake'), { on_hand: 10, reserved: 3 });
  const item = (await call('GET', '/v1/operator/inventory/items', { device: a.device })).json[0];
  assert.equal(item.available, 7, 'reserved stock is not available to anyone else');

  // The farmer's own views of the order say where to collect it.
  const mine = (await call('GET', `/v1/orders/${placed.json.id}`)).json;
  assert.equal(mine.center.name, 'Center hold');
  assert.ok('phone' in mine.center);
  assert.equal((await call('GET', '/v1/orders')).json.find((o) => o.id === placed.json.id).center.centerId, a.centerId);

  const farmerNote = (await call('GET', '/v1/farmer/notifications')).json.find((n) => n.refId === placed.json.id);
  assert.match(farmerNote.body, /Center hold/);
  assert.match(farmerNote.body, /5 days/);
  const opNote = (await call('GET', '/v1/farmer/notifications', { device: a.device })).json.find((n) => n.refId === placed.json.id);
  assert.equal(opNote.title, 'New app order');
  assert.match(opNote.body, /3 x Neem Cake/);
});

test('automatic assignment picks the best center that can cover the whole cart', async () => {
  const near = await makeCenter('auto-near', 0.03, 1);
  const far = await makeCenter('auto-far', 0.06, 1);
  await stock(near, 'p-sprayer', 5); // has one of the two items
  await stock(far, 'p-sprayer', 5);
  await stock(far, 'p-vermicompost', 5); // has both
  const both = [{ productId: 'p-sprayer', quantity: 1 }, { productId: 'p-vermicompost', quantity: 1 }];

  const placed = await order({ ...zoneBase(1), items: both });
  assert.equal(placed.status, 201);
  assert.equal(placed.json.centerId, far.centerId, 'the closer center is skipped: it cannot fill the whole order');
  assert.deepEqual(await shelf(near, 'p-sprayer'), { on_hand: 5, reserved: 0 });
  assert.deepEqual(await shelf(far, 'p-sprayer'), { on_hand: 5, reserved: 1 });

  // The saved location works too, and the village fallback.
  await call('PUT', '/v1/farmer/profile', { device: 'saved', body: { latitude: zoneBase(1).latitude, longitude: zoneBase(1).longitude } });
  assert.equal((await order({ items: both }, 'saved')).json.centerId, far.centerId);
  assert.equal((await order({ village: 'Atlantis', items: cart('p-sprayer', 1) }, 'v')).status, 404);
});

test('when nobody has everything: 409 with the alternatives, nothing is held', async () => {
  const c = await makeCenter('short', 0.04, 2);
  await stock(c, 'p-vermicompost', 1);
  const before = await shelf(c, 'p-vermicompost');
  const res = await order({ ...zoneBase(2), items: cart('p-vermicompost', 50) });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'out_of_stock');
  assert.match(res.json.error, /None of the centers near you/);
  assert.ok(res.json.alternatives.length >= 1);
  assert.ok(res.json.alternatives.every((a) => a.inventoryStatus !== 'all'));
  assert.deepEqual(await shelf(c, 'p-vermicompost'), before);

  assert.equal((await order({ items: cart('p-neemcake', 1) }, 'no-location')).status, 400);
  assert.equal((await order({ ...zoneBase(2), items: cart('nope', 1) })).status, 404);
  assert.equal((await order({ ...zoneBase(2), items: cart('p-vermicompost', 101) })).status, 400, 'a line is capped at 100');
});

test('a farmer can override the recommendation; an override that ran dry is refused, not oversold', async () => {
  const good = await makeCenter('ov-good', 0.02, 3);
  const other = await makeCenter('ov-other', 0.08, 3);
  await stock(good, 'p-sprayer', 5);
  await stock(other, 'p-sprayer', 1);

  const chosen = await order({ ...zoneBase(3), centerId: other.centerId, items: cart('p-sprayer', 1) });
  assert.equal(chosen.json.centerId, other.centerId, 'the farmer chose the farther center');

  const gone = await order({ ...zoneBase(3), centerId: other.centerId, items: cart('p-sprayer', 1) }, 'late-farmer');
  assert.equal(gone.status, 409);
  assert.match(gone.json.error, /just went out of stock/);
  assert.ok(gone.json.alternatives.some((a) => a.centerId === good.centerId && a.inventoryStatus === 'all'));
  assert.ok(gone.json.alternatives.every((a) => a.centerId !== other.centerId), 'the empty center is not offered back');
  assert.deepEqual(await shelf(other, 'p-sprayer'), { on_hand: 1, reserved: 1 });

  // No location at all is fine when the farmer names the center.
  assert.equal((await order({ centerId: good.centerId, items: cart('p-sprayer', 1) }, 'nolocation')).status, 201);
});

test('the last unit goes to exactly one farmer, however many ask at once', async () => {
  const c = await makeCenter('race', 0.02);
  await stock(c, 'p-neemcake', 3);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    order({ centerId: c.centerId, items: cart('p-neemcake', 1) }, `racer-${i}`)));
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  const losers = results.filter((r) => r.status === 409);
  assert.equal(losers.length, 9);
  assert.ok(losers.every((r) => /just went out of stock/.test(r.json.error)));
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 3, reserved: 3 });
});

test('with automatic assignment the loser of the race falls through to the next center', async () => {
  const near = await makeCenter('fall-near', 0.02, 4);
  const far = await makeCenter('fall-far', 0.05, 4);
  await stock(near, 'p-sprayer', 2);
  await stock(far, 'p-sprayer', 20);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => order({ ...zoneBase(4), items: cart('p-sprayer', 1) }, `auto-${i}`)));
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
  const at = (c) => results.filter((r) => r.json.centerId === c.centerId).length;
  assert.equal(at(near), 2, 'the closer center sells out exactly');
  assert.equal(at(far), 6);
  assert.deepEqual(await shelf(near, 'p-sprayer'), { on_hand: 2, reserved: 2 });
  assert.deepEqual(await shelf(far, 'p-sprayer'), { on_hand: 20, reserved: 6 });
});

test('a multi-item order is all-or-nothing at a center, even under contention', async () => {
  const c = await makeCenter('multi', 0.02);
  await stock(c, 'p-neemcake', 10);
  await stock(c, 'p-sprayer', 1);
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    order({ centerId: c.centerId, items: [{ productId: 'p-neemcake', quantity: 2 }, { productId: 'p-sprayer', quantity: 1 }] }, `m-${i}`)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  // The four that failed on the sprayer must not be holding any neem cake.
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 10, reserved: 2 });
  assert.deepEqual(await shelf(c, 'p-sprayer'), { on_hand: 1, reserved: 1 });
});

test('walk-in sales come off the shelf, but never out of what an app order is holding', async () => {
  const c = await makeCenter('walk', 0.02);
  await stock(c, 'p-neemcake', 5);
  await stock(c, 'p-sprayer', 5);
  await order({ centerId: c.centerId, items: cart('p-neemcake', 3) });

  const walk = (items) => call('POST', '/v1/operator/orders/walk-in', { device: c.device, body: { items } });
  const tooMany = await walk([{ productId: 'p-neemcake', quantity: 3, unitPrice: 600 }]);
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.json.error, /Only 2 of Neem Cake available \(3 more reserved for app orders\)/);

  // By name (older clients): the catalog's own name is what gets stored.
  const byName = await walk([{ productName: 'neem cake', quantity: 1, unitPrice: 600 }]);
  assert.equal(byName.status, 201);
  assert.equal(byName.json.items[0].productName, 'Neem Cake');
  const ok = await walk([{ productId: 'p-neemcake', quantity: 1, unitPrice: 600 }]);
  assert.equal(ok.status, 201);
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 3, reserved: 3 });
  assert.equal((await walk([{ productId: 'p-neemcake', quantity: 1, unitPrice: 600 }])).status, 409, 'everything left is reserved');

  assert.equal((await walk([{ productName: 'Unicorn Dust', quantity: 1, unitPrice: 1 }])).status, 400);
  assert.equal((await walk([{ productId: 'nope', quantity: 1, unitPrice: 1 }])).status, 404);
  assert.equal((await walk([{ quantity: 1, unitPrice: 1 }])).status, 400);

  // One bad line undoes the whole sale.
  const partial = await walk([{ productId: 'p-sprayer', quantity: 2, unitPrice: 1 }, { productId: 'p-neemcake', quantity: 99, unitPrice: 1 }]);
  assert.equal(partial.status, 409);
  assert.deepEqual(await shelf(c, 'p-sprayer'), { on_hand: 5, reserved: 0 });
  assert.equal((await call('GET', '/v1/operator/orders?type=walkIn', { device: c.device })).json.length, 2);

  // A product the center has never stocked cannot be sold.
  const unstocked = await walk([{ productId: 'p-vermicompost', quantity: 1, unitPrice: 450 }]);
  assert.equal(unstocked.status, 409);
  assert.match(unstocked.json.error, /not in this center's stock/);
});

test('collecting consumes the stock; cancelling releases it; neither can happen twice', async () => {
  const c = await makeCenter('life', 0.02);
  await stock(c, 'p-neemcake', 10);
  const op = { device: c.device };

  const first = (await order({ centerId: c.centerId, items: cart('p-neemcake', 2) }, 'life-1')).json;
  const second = (await order({ centerId: c.centerId, items: cart('p-neemcake', 3) }, 'life-2')).json;
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 10, reserved: 5 });

  // The farmer cancels: the hold is released and only once.
  assert.equal((await call('POST', `/v1/orders/${first.id}/cancel`, { device: 'life-1' })).status, 200);
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 10, reserved: 3 });
  assert.equal((await call('POST', `/v1/orders/${first.id}/cancel`, { device: 'life-1' })).status, 409);
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 10, reserved: 3 });

  // The operator hands the second one over: the goods leave the shelf.
  await call('POST', `/v1/operator/orders/${second.id}/ready`, op);
  await call('POST', `/v1/operator/orders/${second.id}/verify-otp`, { ...op, body: { otp: second.pickupOtp } });
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 7, reserved: 0 });
  assert.equal((await call('POST', `/v1/operator/orders/${second.id}/verify-otp`, { ...op, body: { otp: second.pickupOtp } })).status, 409);
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 7, reserved: 0 });

  // The operator cancelling also releases.
  const third = (await order({ centerId: c.centerId, items: cart('p-neemcake', 4) }, 'life-3')).json;
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 7, reserved: 4 });
  await call('POST', `/v1/operator/orders/${third.id}/cancel`, op);
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 7, reserved: 0 });
});

test('the first center a farmer collects from becomes their home center, and stays', async () => {
  const one = await makeCenter('home-1', 0.02);
  const two = await makeCenter('home-2', 0.04);
  await stock(one, 'p-neemcake', 5);
  await stock(two, 'p-neemcake', 5);
  const collect = async (c, farmer) => {
    const o = (await order({ centerId: c.centerId, items: cart('p-neemcake', 1) }, farmer)).json;
    await call('POST', `/v1/operator/orders/${o.id}/ready`, { device: c.device });
    await call('POST', `/v1/operator/orders/${o.id}/verify-otp`, { device: c.device, body: { otp: o.pickupOtp } });
  };
  assert.equal((await call('GET', '/v1/farmer/profile', { device: 'homebody' })).json.homeCenterId, null);
  await collect(one, 'homebody');
  assert.equal((await call('GET', '/v1/farmer/profile', { device: 'homebody' })).json.homeCenterId, one.centerId);
  await collect(two, 'homebody');
  assert.equal((await call('GET', '/v1/farmer/profile', { device: 'homebody' })).json.homeCenterId, one.centerId, 'a later pickup elsewhere does not move it');
});

test('orders from before reservations existed never touch the shelf', async () => {
  const c = await makeCenter('legacy', 0.02);
  await stock(c, 'p-neemcake', 4);
  await db.query(
    `INSERT INTO orders (id, customer_name, type, status, owner_id, center_id, pickup_otp) VALUES ('order-legacy','Old','appOrder','pending','old-farmer',$1,'1234')`, [c.centerId]);
  await db.query(`INSERT INTO order_items (order_id, position, product_name, quantity, unit_price) VALUES ('order-legacy',0,'Neem Cake',2,600)`);
  await call('POST', '/v1/operator/orders/order-legacy/cancel', { device: c.device });
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 4, reserved: 0 });
});

test('reservations expire after 5 days: the order is cancelled, the stock returns, both sides are told', async () => {
  const c = await makeCenter('expire', 0.02);
  await stock(c, 'p-neemcake', 6);
  const held = (await order({ centerId: c.centerId, items: cart('p-neemcake', 2) }, 'expirer')).json;
  const ready = (await order({ centerId: c.centerId, items: cart('p-neemcake', 1) }, 'ready-expirer')).json;
  await call('POST', `/v1/operator/orders/${ready.id}/ready`, { device: c.device });
  const collected = (await order({ centerId: c.centerId, items: cart('p-neemcake', 1) }, 'collector')).json;
  await call('POST', `/v1/operator/orders/${collected.id}/ready`, { device: c.device });
  await call('POST', `/v1/operator/orders/${collected.id}/verify-otp`, { device: c.device, body: { otp: collected.pickupOtp } });
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 5, reserved: 3 });

  const now = Date.now();
  // The job is global, so it also expires every other still-held order left by
  // earlier tests; compare against how many were held.
  const held5 = async () => (await db.query("SELECT count(*)::int AS n FROM orders WHERE stock_reserved AND status IN ('pending','readyForPickup')")).rows[0].n;
  const active = await held5();
  assert.ok(active >= 2);
  // Not due yet: nothing is cancelled.
  assert.equal((await runMaintenance(db, new Date(now + 4 * DAY))).expired, 0);
  assert.equal((await call('GET', `/v1/orders/${held.id}`, { device: 'expirer' })).json.status, 'pending');

  const pass = await runMaintenance(db, new Date(now + 5 * DAY + 60 * 1000));
  assert.equal(pass.expired, active, 'every held order is expired: pending and ready-for-pickup alike');
  assert.equal(await held5(), 0);
  assert.equal((await call('GET', `/v1/orders/${held.id}`, { device: 'expirer' })).json.status, 'cancelled');
  assert.equal((await call('GET', `/v1/orders/${ready.id}`, { device: 'ready-expirer' })).json.status, 'cancelled');
  assert.equal((await call('GET', `/v1/orders/${collected.id}`, { device: 'collector' })).json.status, 'completed');
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 5, reserved: 0 });
  assert.ok((await titles('expirer')).includes('Your reservation expired'));
  assert.ok((await titles(c.device)).includes('Reservation expired'));

  // Running it again does nothing: no double release, no duplicate messages.
  assert.equal((await runMaintenance(db, new Date(now + 6 * DAY))).expired, 0);
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 5, reserved: 0 });
  assert.equal((await titles('expirer')).filter((t) => t === 'Your reservation expired').length, 1);
});

test('reminders go out as day 3 and day 5 begin, once each, and a late job sends only the latest', async () => {
  const c = await makeCenter('remind', 0.02);
  await stock(c, 'p-neemcake', 10);
  const a = (await order({ centerId: c.centerId, items: cart('p-neemcake', 1) }, 'rem-a')).json;
  const b = (await order({ centerId: c.centerId, items: cart('p-neemcake', 1) }, 'rem-b')).json;
  assert.ok(a && b);
  const now = Date.now();
  const reminders = async (device) => (await titles(device)).filter((t) => /waiting for you|Last day/.test(t));

  await runMaintenance(db, new Date(now + 1 * DAY));
  assert.deepEqual(await reminders('rem-a'), [], 'day 2: too early');

  const day3 = await runMaintenance(db, new Date(now + 2 * DAY + 60 * 1000));
  assert.equal(day3.reminded, 2);
  assert.deepEqual(await reminders('rem-a'), ['Your order is waiting for you']);
  assert.equal((await runMaintenance(db, new Date(now + 3 * DAY))).reminded, 0, 'day 3 reminder is not repeated');

  // The job was down through day 4: rem-b jumps to... it already had day 3, so it gets the last-day one.
  const day5 = await runMaintenance(db, new Date(now + 4 * DAY + 60 * 1000));
  assert.equal(day5.reminded, 2);
  assert.deepEqual(await reminders('rem-a'), ['Last day to collect your order', 'Your order is waiting for you']);
  assert.equal((await runMaintenance(db, new Date(now + 4 * DAY + 2 * 60 * 1000))).reminded, 0);

  // A brand-new order the job first sees on day 5 gets only the last-day reminder.
  const late = (await order({ centerId: c.centerId, items: cart('p-neemcake', 1) }, 'rem-late')).json;
  assert.ok(late);
  await runMaintenance(db, new Date(Date.now() + 4 * DAY + 60 * 1000));
  assert.deepEqual(await reminders('rem-late'), ['Last day to collect your order']);
});

test('the job is safe to run from several instances at once', async () => {
  const c = await makeCenter('twice', 0.02);
  await stock(c, 'p-neemcake', 3);
  await order({ centerId: c.centerId, items: cart('p-neemcake', 1) }, 'twice-1');
  const future = new Date(Date.now() + 6 * DAY);
  const held = (await db.query("SELECT count(*)::int AS n FROM orders WHERE stock_reserved AND status IN ('pending','readyForPickup')")).rows[0].n;
  assert.ok(held >= 1);
  // The lock is database-wide and test files run in parallel, so another file's run can
  // make all three of ours skip; try again until one really ran.
  let results;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    results = await Promise.all([runMaintenanceRaw(db, future), runMaintenanceRaw(db, future), runMaintenanceRaw(db, future)]);
    if (results.some((r) => !r.skipped)) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.equal(results.reduce((n, r) => n + r.expired, 0), held, 'each order is expired exactly once across all runs');
  assert.ok(results.some((r) => r.skipped) || results.filter((r) => r.expired).length === 1, 'runs do not overlap');
  assert.deepEqual(await shelf(c, 'p-neemcake'), { on_hand: 3, reserved: 0 });
});
