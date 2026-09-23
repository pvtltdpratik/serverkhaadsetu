process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');

// Operator tooling: low-stock alerts, the farmer list built from orders, and
// delivery discrepancies (anonymous X-Device-Id mode).
const BASE = { latitude: 18.5, longitude: 74.0 };

let server;
let base;
let db;
let counter = 0;

const call = async (method, path, { body, device = 'farmer-1' } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-device-id': device },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};

const makeCenter = async (key) => {
  counter += 1;
  const op = `op-${key}-${counter}`;
  await call('GET', '/v1/me', { device: op });
  const res = await call('POST', '/v1/admin/centers', {
    device: 'admin',
    body: { name: `Center ${key}`, village: key, latitude: BASE.latitude, longitude: BASE.longitude, operatorId: op, opensAt: '00:00', closesAt: '23:59' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { ...res.json, device: op };
};
const receive = (c, productId, quantity, extra = {}) => call('POST', '/v1/operator/inventory/receive', { device: c.device, body: { productId, quantity, ...extra } });
const setLevel = (c, productId, reorderLevel) => call('PATCH', `/v1/operator/inventory/items/${productId}`, { device: c.device, body: { reorderLevel } });
const order = (c, quantity, device = 'farmer-1', productId = 'p-neemcake') =>
  call('POST', '/v1/orders', { device, body: { centerId: c.centerId, items: [{ productId, quantity }] } });
const walkIn = (c, quantity, productId = 'p-neemcake') =>
  call('POST', '/v1/operator/orders/walk-in', { device: c.device, body: { items: [{ productId, quantity, unitPrice: 600 }] } });
const stockAlerts = async (c) => (await call('GET', '/v1/farmer/notifications', { device: c.device })).json.filter((n) => n.type === 'stock');
const item = async (c, productId = 'p-neemcake') => (await call('GET', '/v1/operator/inventory/items', { device: c.device })).json.find((i) => i.id === productId);

test.before(async () => {
  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  db = await openTestDb('t_operator');
  const app = createApp(db);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

test('an app order that pushes stock to the reorder level alerts the operator once, and only once per dip', async () => {
  const c = await makeCenter('alert');
  await receive(c, 'p-neemcake', 10);
  await setLevel(c, 'p-neemcake', 5);
  assert.equal((await stockAlerts(c)).length, 0, 'plenty of stock: nothing to say');

  await order(c, 3); // 7 available
  assert.equal((await stockAlerts(c)).length, 0);
  await order(c, 3); // 4 available: at or under 5
  const alerts = await stockAlerts(c);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'Low stock: Neem Cake');
  assert.match(alerts[0].body, /Only 4 left to sell \(reorder level 5\)/);
  assert.equal(alerts[0].refId, 'p-neemcake');

  await order(c, 1); // 3 available: still low, but already told
  assert.equal((await stockAlerts(c)).length, 1, 'no repeat while it stays low');
  assert.equal((await item(c)).isLowStock, true);
});

test('cancelling or restocking re-arms the alert, so the next dip alerts again', async () => {
  const c = await makeCenter('rearm');
  await receive(c, 'p-neemcake', 10);
  await setLevel(c, 'p-neemcake', 5);
  const a = (await order(c, 6)).json; // 4 available -> alert #1
  assert.equal((await stockAlerts(c)).length, 1);

  await call('POST', `/v1/orders/${a.id}/cancel`, { device: 'farmer-1' }); // back to 10 available
  assert.equal((await stockAlerts(c)).length, 1);
  await order(c, 7, 'farmer-2'); // 3 available -> alert #2
  assert.equal((await stockAlerts(c)).length, 2);

  await receive(c, 'p-neemcake', 20); // 23 available: recovered
  await order(c, 20, 'farmer-3'); // 3 available -> alert #3
  assert.equal((await stockAlerts(c)).length, 3);
});

test('a walk-in sale can trigger it, and running out says so', async () => {
  const c = await makeCenter('walkalert');
  await receive(c, 'p-neemcake', 6);
  await setLevel(c, 'p-neemcake', 3);
  await walkIn(c, 2); // 4 left
  assert.equal((await stockAlerts(c)).length, 0);
  await walkIn(c, 1); // 3 left
  assert.equal((await stockAlerts(c))[0].title, 'Low stock: Neem Cake');
  await receive(c, 'p-sprayer', 2);
  await setLevel(c, 'p-sprayer', 0);
  await walkIn(c, 2, 'p-sprayer'); // nothing left
  const out = (await stockAlerts(c)).find((n) => n.refId === 'p-sprayer');
  assert.match(out.title, /^Out of stock: /);
  assert.match(out.body, /has run out/);
});

test('changing the reorder level can put a product on the low side, and a failed sale leaves no alert', async () => {
  const c = await makeCenter('level');
  await receive(c, 'p-neemcake', 8);
  await setLevel(c, 'p-neemcake', 5);
  assert.equal((await stockAlerts(c)).length, 0);
  await setLevel(c, 'p-neemcake', 10); // 8 available is now under the level
  assert.equal((await stockAlerts(c)).length, 1);

  // A sale that would cross the line but fails on another line is rolled back whole,
  // so it leaves neither a changed shelf nor an alert.
  const c2 = await makeCenter('failed');
  await receive(c2, 'p-neemcake', 5);
  await receive(c2, 'p-sprayer', 1);
  await setLevel(c2, 'p-neemcake', 4); // 5 available: not low yet
  const failed = await call('POST', '/v1/operator/orders/walk-in', {
    device: c2.device,
    body: { items: [{ productId: 'p-neemcake', quantity: 2, unitPrice: 600 }, { productId: 'p-sprayer', quantity: 9, unitPrice: 1 }] },
  });
  assert.equal(failed.status, 409);
  assert.equal((await item(c2)).currentStock, 5);
  assert.equal((await stockAlerts(c2)).length, 0, 'the sale rolled back, so did its alert');
  assert.equal((await walkIn(c2, 2)).status, 201);
  assert.equal((await stockAlerts(c2)).length, 1, 'the same sale, done properly, does alert');
});

test('the admin overview flags stock that has stayed low for a day', async () => {
  const c = await makeCenter('unattended');
  await receive(c, 'p-neemcake', 5);
  await setLevel(c, 'p-neemcake', 5); // already low -> alerted at once
  const before = (await call('GET', '/v1/admin/overview', { device: 'admin' })).json;
  assert.ok(before.lowStockItems >= 1);
  const base_ = before.lowStockUnattended;

  await db.query("UPDATE center_inventory SET low_stock_alerted_at = now() - interval '25 hours' WHERE center_id = $1", [c.centerId]);
  assert.equal((await call('GET', '/v1/admin/overview', { device: 'admin' })).json.lowStockUnattended, base_ + 1);

  await receive(c, 'p-neemcake', 20); // the operator acts
  assert.equal((await call('GET', '/v1/admin/overview', { device: 'admin' })).json.lowStockUnattended, base_);
});

test('the farmer list is the real customers who ordered here, newest first', async () => {
  const c = await makeCenter('crm');
  const other = await makeCenter('crm-other');
  await receive(c, 'p-neemcake', 50);
  await receive(other, 'p-neemcake', 50);
  await call('PUT', '/v1/farmer/profile', { device: 'asha', body: { name: 'Asha Patil', village: 'Shirur, Pune' } });
  await order(c, 1, 'asha');
  await order(c, 1, 'asha');
  await order(c, 1, 'bhau'); // no profile: falls back to the name on the order
  const cancelled = (await order(c, 1, 'chitra')).json;
  await call('POST', `/v1/orders/${cancelled.id}/cancel`, { device: 'chitra' });
  await order(other, 1, 'dinesh'); // a different center's customer
  await walkIn(c, 1); // walk-ins have no account, so no entry

  const list = await call('GET', '/v1/operator/farmers', { device: c.device });
  assert.deepEqual(list.json.map((f) => f.id).sort(), ['asha', 'bhau']);
  assert.equal(list.headers.get('x-total-count'), '2');
  const asha = list.json.find((f) => f.id === 'asha');
  assert.equal(asha.name, 'Asha Patil');
  assert.equal(asha.village, 'Shirur, Pune');
  assert.equal(asha.ordersCount, 2);
  assert.equal(asha.needsFollowUp, false);
  assert.equal(list.json.find((f) => f.id === 'bhau').name, 'Farmer');
  assert.equal((await call('GET', '/v1/operator/farmers?q=asha', { device: c.device })).json.length, 1);
  assert.equal((await call('GET', '/v1/operator/farmers?q=shirur', { device: c.device })).json.length, 1, 'searches the village too');

  assert.equal((await call('GET', '/v1/operator/farmers/asha', { device: c.device })).json.ordersCount, 2);
  assert.equal((await call('GET', '/v1/operator/farmers/dinesh', { device: c.device })).status, 404, 'another center\'s customer');
  assert.equal((await call('GET', '/v1/operator/farmers/chitra', { device: c.device })).status, 404, 'only cancelled orders');
  assert.equal((await call('GET', '/v1/operator/farmers', { device: other.device })).json.length, 1);

  // A customer who has not ordered for a month needs a follow-up.
  await db.query("UPDATE orders SET created_at = now() - interval '40 days' WHERE owner_id = 'bhau'");
  const stale = await call('GET', '/v1/operator/farmers?needsFollowUp=true', { device: c.device });
  assert.deepEqual(stale.json.map((f) => f.id), ['bhau']);
  assert.deepEqual((await call('GET', '/v1/operator/farmers?needsFollowUp=false', { device: c.device })).json.map((f) => f.id), ['asha']);
  assert.equal((await call('GET', '/v1/operator/farmers', { device: c.device })).json[0].id, 'asha', 'most recent customer first');
});

test('a delivery that does not match is recorded for the supply team, and the shelf gets what arrived', async () => {
  const c = await makeCenter('disc');
  const plain = await receive(c, 'p-neemcake', 10, { expectedQuantity: 10 });
  assert.equal(plain.json.discrepancy, undefined, 'a matching count records nothing');

  const short = await receive(c, 'p-neemcake', 8, { expectedQuantity: 10, note: '2 bags were torn' });
  assert.equal(short.status, 201);
  assert.deepEqual({ ...short.json.discrepancy, id: 'x' }, { id: 'x', expected: 10, received: 8 });
  assert.equal(short.json.currentStock, 18, 'the 8 that arrived are on the shelf');

  assert.equal((await receive(c, 'p-neemcake', 5, { expectedQuantity: -1 })).status, 400);
  assert.equal((await receive(c, 'p-neemcake', 5, { expectedQuantity: 'lots' })).status, 400);
  assert.equal((await item(c)).currentStock, 18);

  const open = await call('GET', '/v1/admin/discrepancies?status=open', { device: 'admin' });
  const d = open.json.find((x) => x.centerId === c.centerId);
  assert.equal(d.productName, 'Neem Cake');
  assert.equal(d.expectedQuantity, 10);
  assert.equal(d.receivedQuantity, 8);
  assert.equal(d.note, '2 bags were torn');
  assert.equal(d.centerName, 'Center disc');
  const openCount = (await call('GET', '/v1/admin/overview', { device: 'admin' })).json.discrepanciesOpen;
  assert.ok(openCount >= 1);

  const resolved = await call('PATCH', `/v1/admin/discrepancies/${d.id}`, { device: 'admin', body: { note: 'Credit note raised with the supplier' } });
  assert.equal(resolved.json.status, 'resolved');
  assert.equal((await call('PATCH', `/v1/admin/discrepancies/${d.id}`, { device: 'admin', body: {} })).status, 409);
  assert.equal((await call('PATCH', '/v1/admin/discrepancies/nope', { device: 'admin', body: {} })).status, 404);
  assert.equal((await call('GET', '/v1/admin/overview', { device: 'admin' })).json.discrepanciesOpen, openCount - 1);
  assert.equal((await call('GET', '/v1/admin/discrepancies?status=resolved', { device: 'admin' })).json.find((x) => x.id === d.id).resolutionNote, 'Credit note raised with the supplier');

  const told = (await stockAlerts(c)).find((n) => n.title === 'Delivery discrepancy reviewed');
  assert.match(told.body, /Credit note raised/);
  const audit = (await call('GET', `/v1/admin/audit?targetId=${d.id}`, { device: 'admin' })).json;
  assert.equal(audit[0].action, 'discrepancy.resolve');
  assert.equal((await call('GET', '/v1/admin/discrepancies?status=bogus', { device: 'admin' })).status, 400);
});
