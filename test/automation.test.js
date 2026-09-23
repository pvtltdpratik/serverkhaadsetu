process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');

// Orders moving off a center that cannot serve them, and "notify me when
// available" (anonymous X-Device-Id mode). Each test works in its own map zone
// (one degree of latitude, ~111 km, from every other) so centers left over from
// earlier tests are never candidates.
const BASE = { latitude: 18.5, longitude: 74.0 };
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

let server;
let base;
let db;
let counter = 0;
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

const zone = (z) => ({ latitude: BASE.latitude + z, longitude: BASE.longitude });
const makeCenter = async (key, dLat, z, extra = {}) => {
  counter += 1;
  const op = `op-${key}-${counter}`;
  await call('GET', '/v1/me', { device: op });
  const res = await call('POST', '/v1/admin/centers', {
    device: 'admin',
    body: { name: `Center ${key}`, village: key, latitude: BASE.latitude + z + dLat, longitude: BASE.longitude, operatorId: op, opensAt: '00:00', closesAt: '23:59', ...extra },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { ...res.json, device: op };
};
const stock = (c, productId, quantity) => call('POST', '/v1/operator/inventory/receive', { device: c.device, body: { productId, quantity } });
const order = (c, device = 'farmer-1', z = null, quantity = 2) =>
  call('POST', '/v1/orders', { device, body: { centerId: c.centerId, items: [{ productId: 'p-neemcake', quantity }], ...(z === null ? {} : zone(z)) } });
const shelf = async (c) => (await db.query("SELECT on_hand, reserved FROM center_inventory WHERE center_id = $1 AND product_id = 'p-neemcake'", [c.centerId])).rows[0];
const titles = async (device) => (await call('GET', '/v1/farmer/notifications', { device })).json.map((n) => n.title);
const bodies = async (device) => (await call('GET', '/v1/farmer/notifications', { device })).json.map((n) => n.body);
const centerOf = async (orderId) => (await db.query('SELECT center_id, reassign_count, status, pickup_otp FROM orders WHERE id = $1', [orderId])).rows[0];
const later = (minutes) => new Date(Date.now() + minutes * MIN);
const eventually = async (check, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};

test.before(async () => {
  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  ({ runReassignment } = require('../src/services/reassignment'));
  db = await openTestDb('t_automation');
  const app = createApp(db);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

test('a closed center\'s waiting order moves to the next center that has everything, with its stock', async () => {
  const a = await makeCenter('a', 0.02, 1);
  const b = await makeCenter('b', 0.05, 1);
  await stock(a, 'p-neemcake', 5);
  await stock(b, 'p-neemcake', 5);
  const placed = (await order(a, 'mover', 1)).json;
  assert.equal(placed.centerId, a.centerId);
  const before = await centerOf(placed.id);

  await call('PATCH', '/v1/operator/center', { device: a.device, body: { isOpen: false } });
  assert.equal((await runReassignment(db, { now: later(5) })).moved, 0, 'inside the 30 minute grace: a short break is not a reason');
  assert.equal((await centerOf(placed.id)).center_id, a.centerId);

  const run = await runReassignment(db, { now: later(31) });
  assert.equal(run.moved, 1);
  const after = await centerOf(placed.id);
  assert.equal(after.center_id, b.centerId);
  assert.equal(after.reassign_count, 1);
  assert.equal(after.status, 'pending');
  assert.equal(after.pickup_otp, before.pickup_otp, 'the pickup code does not change');
  assert.deepEqual(await shelf(a), { on_hand: 5, reserved: 0 });
  assert.deepEqual(await shelf(b), { on_hand: 5, reserved: 2 });

  const farmerView = (await call('GET', `/v1/orders/${placed.id}`, { device: 'mover' })).json;
  assert.equal(farmerView.center.name, 'Center b');
  assert.equal(farmerView.reservedUntil, placed.reservedUntil, 'the deadline is not extended');

  const told = (await call('GET', '/v1/farmer/notifications', { device: 'mover' })).json.find((n) => n.title === 'Your order was moved to another center');
  assert.match(told.body, /Center a has been closed by its operator/);
  assert.match(told.body, /Center b, b/);
  assert.equal(told.refId, placed.id);
  assert.ok((await titles(a.device)).includes('An order was moved away from your center'));
  const arrived = (await call('GET', '/v1/farmer/notifications', { device: b.device })).json.find((n) => n.title === 'New app order (moved to you)');
  assert.match(arrived.body, /2 x Neem Cake/);
  assert.match(arrived.body, /moved from Center a/);

  // It is done: running again finds nothing to move.
  assert.equal((await runReassignment(db, { now: later(60) })).moved, 0);
});

test('an order the operator has already confirmed is left alone, and so is a center that is fine', async () => {
  const a = await makeCenter('a', 0.02, 2);
  const b = await makeCenter('b', 0.05, 2);
  await stock(a, 'p-neemcake', 9);
  await stock(b, 'p-neemcake', 9);
  const confirmed = (await order(a, 'f1', 2)).json;
  const waiting = (await order(a, 'f2', 2)).json;
  await call('POST', `/v1/operator/orders/${confirmed.id}/ready`, { device: a.device });

  assert.equal((await runReassignment(db, { now: later(120) })).moved, 0, 'the center is open, so nobody moves');
  await call('PATCH', '/v1/operator/center', { device: a.device, body: { isOpen: false } });
  const run = await runReassignment(db, { now: later(120) });
  assert.equal(run.moved, 1);
  assert.equal((await centerOf(confirmed.id)).center_id, a.centerId, 'ready for pickup: the operator already prepared it');
  assert.equal((await centerOf(waiting.id)).center_id, b.centerId);
});

test('nowhere better to go: the order stays put and nothing is held twice', async () => {
  const a = await makeCenter('a', 0.02, 3);
  const b = await makeCenter('b', 0.05, 3);
  await stock(a, 'p-neemcake', 5);
  await stock(b, 'p-neemcake', 1); // cannot fill an order for 2
  const placed = (await order(a, 'stuck', 3)).json;
  await call('PATCH', '/v1/operator/center', { device: a.device, body: { isOpen: false } });

  const run = await runReassignment(db, { now: later(60) });
  assert.deepEqual([run.moved, run.stuck], [0, 1]);
  assert.equal((await centerOf(placed.id)).center_id, a.centerId);
  assert.deepEqual(await shelf(a), { on_hand: 5, reserved: 2 });
  assert.deepEqual(await shelf(b), { on_hand: 1, reserved: 0 });

  await stock(b, 'p-neemcake', 5); // the backup restocks: the next pass can move it
  assert.equal((await runReassignment(db, { now: later(70) })).moved, 1);
  assert.equal((await centerOf(placed.id)).center_id, b.centerId);
});

test('a suspended center, or one whose operator was suspended, cannot keep orders either', async () => {
  const a = await makeCenter('a', 0.02, 4);
  const a2 = await makeCenter('a2', 0.03, 4);
  const b = await makeCenter('b', 0.05, 4);
  for (const c of [a, a2, b]) await stock(c, 'p-neemcake', 9);
  const o1 = (await order(a, 'g1', 4)).json;
  const o2 = (await order(a2, 'g2', 4)).json;

  await call('PATCH', `/v1/admin/centers/${a.centerId}`, { device: 'admin', body: { status: 'suspended' } });
  await call('PATCH', `/v1/admin/users/${a2.operatorId}`, { device: 'admin', body: { status: 'suspended' } });
  const run = await runReassignment(db, { now: later(60) });
  assert.equal(run.moved, 2);
  assert.notEqual((await centerOf(o1.id)).center_id, a.centerId);
  assert.notEqual((await centerOf(o2.id)).center_id, a2.centerId);
  assert.ok((await bodies('g1')).some((t) => /is not taking orders at the moment/.test(t)));
});

test('a center silent for 12 hours is offline, but only silence during its opening hours counts', async () => {
  const a = await makeCenter('a', 0.02, 5, { opensAt: '09:00', closesAt: '18:00' });
  const b = await makeCenter('b', 0.05, 5, { opensAt: '00:00', closesAt: '23:59' });
  await stock(a, 'p-neemcake', 9);
  await stock(b, 'p-neemcake', 9);
  const placed = (await order(a, 'quiet', 5)).json;
  // Silent since 12:00 IST the day before.
  await db.query("UPDATE village_center SET last_active_at = '2029-12-31T06:30:00Z' WHERE center_id = $1", [a.centerId]);

  // 20:00 IST: it is night, so no one expects to hear from the operator.
  assert.equal((await runReassignment(db, { now: new Date('2030-01-01T14:30:00Z') })).moved, 0);
  // 12:00 IST: open and 24 hours quiet: offline.
  assert.equal((await runReassignment(db, { now: new Date('2030-01-01T06:30:00Z') })).moved, 1);
  assert.equal((await centerOf(placed.id)).center_id, b.centerId);
  assert.ok((await bodies('quiet')).some((t) => /has not been reachable/.test(t)));
});

test('being active keeps a center online: any operator request counts, at most once a minute', async () => {
  const a = await makeCenter('a', 0.02, 6);
  const set = (sql) => db.query(`UPDATE village_center SET last_active_at = ${sql} WHERE center_id = $1`, [a.centerId]);
  const read = async () => new Date((await db.one('SELECT last_active_at FROM village_center WHERE center_id = $1', [a.centerId])).last_active_at).getTime();

  await set("now() - interval '3 hours'");
  const stale = await read();
  await call('GET', '/v1/operator/inventory/items', { device: a.device });
  assert.ok((await read()) > stale + 2 * HOUR, 'refreshed');

  await set("now() - interval '10 seconds'");
  const recent = await read();
  await call('GET', '/v1/operator/inventory/items', { device: a.device });
  assert.equal(await read(), recent, 'not rewritten on every request');
});

test('an order moves at most twice, and can be moved when it had no recorded location', async () => {
  const a = await makeCenter('a', 0.02, 7);
  const b = await makeCenter('b', 0.05, 7);
  await stock(a, 'p-neemcake', 9);
  await stock(b, 'p-neemcake', 9);
  // Ordered with only a chosen center: no farmer location was recorded, so the
  // old center's position stands in for "near them".
  const placed = (await order(a, 'noloc')).json;
  assert.equal((await db.one('SELECT origin_latitude FROM orders WHERE id = $1', [placed.id])).origin_latitude, null);

  await db.query('UPDATE orders SET reassign_count = 2 WHERE id = $1', [placed.id]);
  await call('PATCH', '/v1/operator/center', { device: a.device, body: { isOpen: false } });
  assert.equal((await runReassignment(db, { now: later(60) })).moved, 0, 'already moved twice');

  await db.query('UPDATE orders SET reassign_count = 1 WHERE id = $1', [placed.id]);
  assert.equal((await runReassignment(db, { now: later(60) })).moved, 1);
  assert.deepEqual([(await centerOf(placed.id)).center_id, (await centerOf(placed.id)).reassign_count], [b.centerId, 2]);
});

test('two passes at once move an order exactly once', async () => {
  const a = await makeCenter('a', 0.02, 8);
  const b = await makeCenter('b', 0.05, 8);
  await stock(a, 'p-neemcake', 20);
  await stock(b, 'p-neemcake', 20);
  const placed = await Promise.all(Array.from({ length: 4 }, (_, i) => order(a, `race-${i}`, 8)));
  await call('PATCH', '/v1/operator/center', { device: a.device, body: { isOpen: false } });
  const now = later(60);
  const runs = await Promise.all([runReassignment(db, { now }), runReassignment(db, { now }), runReassignment(db, { now })]);
  assert.equal(runs.reduce((n, r) => n + r.moved, 0), 4);
  assert.deepEqual(await shelf(a), { on_hand: 20, reserved: 0 });
  assert.deepEqual(await shelf(b), { on_hand: 20, reserved: 8 });
  for (const p of placed) assert.equal((await centerOf(p.json.id)).reassign_count, 1);
});

test('notify me: subscribing needs a place, is idempotent, and can be undone', async () => {
  assert.equal((await call('GET', '/v1/products/nope/notify-me')).status, 404);
  assert.equal((await call('PUT', '/v1/products/nope/notify-me', { body: { ...zone(20) } })).status, 404);
  assert.equal((await call('PUT', '/v1/products/p-neemcake/notify-me', { device: 'nowhere', body: {} })).status, 400);
  assert.equal((await call('PUT', '/v1/products/p-neemcake/notify-me', { device: 'nowhere', body: { latitude: 500, longitude: 1 } })).status, 400);

  const sub = () => call('GET', '/v1/products/p-neemcake/notify-me', { device: 'subber' });
  assert.equal((await sub()).json.subscribed, false);
  assert.equal((await call('PUT', '/v1/products/p-neemcake/notify-me', { device: 'subber', body: zone(20) })).json.subscribed, true);
  assert.equal((await call('PUT', '/v1/products/p-neemcake/notify-me', { device: 'subber', body: zone(20) })).status, 200, 'again is fine');
  assert.equal((await sub()).json.subscribed, true);
  assert.equal((await call('GET', '/v1/products/p-neemcake/notify-me', { device: 'someone-else' })).json.subscribed, false);
  assert.equal((await call('DELETE', '/v1/products/p-neemcake/notify-me', { device: 'subber' })).json.subscribed, false);
  assert.equal((await sub()).json.subscribed, false);

  // Without a place in the request, the saved one is used.
  await call('PUT', '/v1/farmer/profile', { device: 'saved', body: { latitude: 18.5, longitude: 74 } });
  assert.equal((await call('PUT', '/v1/products/p-neemcake/notify-me', { device: 'saved', body: {} })).status, 200);
});

test('notify me: a center receiving the product tells everyone in range once, and only them', async () => {
  const c = await makeCenter('nm', 0.02, 9);
  const at = (dLat) => ({ latitude: BASE.latitude + 9 + dLat, longitude: BASE.longitude });
  const subscribe = (device, where, product = 'p-neemcake') => call('PUT', `/v1/products/${product}/notify-me`, { device, body: where });
  await subscribe('near-1', at(0.01)); //   ~1 km from the center
  await subscribe('near-2', at(0.2)); //    ~20 km
  await subscribe('too-far', at(0.5)); //   ~53 km
  await subscribe('other-product', at(0.01), 'p-sprayer');

  await stock(c, 'p-neemcake', 4);
  const told = await eventually(async () => (await titles('near-2')).includes('Neem Cake is back in stock'));
  assert.ok(told, 'the notification arrives shortly after the receipt');
  const note = (await call('GET', '/v1/farmer/notifications', { device: 'near-1' })).json.find((n) => n.type === 'stock');
  assert.equal(note.title, 'Neem Cake is back in stock');
  assert.match(note.body, /Center nm, nm/);
  assert.equal(note.refId, 'p-neemcake');

  assert.deepEqual(await titles('too-far'), [], 'outside the range');
  assert.deepEqual(await titles('other-product'), [], 'a different product');
  for (const who of ['near-1', 'near-2']) {
    assert.equal((await call('GET', '/v1/products/p-neemcake/notify-me', { device: who })).json.subscribed, false, 'one-shot');
  }
  assert.equal((await call('GET', '/v1/products/p-neemcake/notify-me', { device: 'too-far' })).json.subscribed, true, 'still waiting');

  // More stock later: nobody is told twice.
  await stock(c, 'p-neemcake', 4);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await titles('near-1')).filter((t) => t === 'Neem Cake is back in stock').length, 1);
});

test('notify me: a farmer who resubscribes after being told is told again next time', async () => {
  const c = await makeCenter('again', 0.02, 10);
  const where = { latitude: BASE.latitude + 10.01, longitude: BASE.longitude };
  await call('PUT', '/v1/products/p-neemcake/notify-me', { device: 'again-1', body: where });
  await stock(c, 'p-neemcake', 2);
  await eventually(async () => (await titles('again-1')).length === 1);
  await call('PUT', '/v1/products/p-neemcake/notify-me', { device: 'again-1', body: where });
  await stock(c, 'p-neemcake', 2);
  assert.ok(await eventually(async () => (await titles('again-1')).length === 2));
});
