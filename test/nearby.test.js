process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');

// Center discovery end to end (anonymous X-Device-Id mode). Centers sit on a
// north-south line at longitude 74.0; 0.01 degrees of latitude is ~1.11 km.
const BASE = { latitude: 18.5, longitude: 74.0 };
const at = (dLat) => ({ latitude: BASE.latitude + dLat, longitude: BASE.longitude });

let server;
let base;
let db;
const centers = {};

const call = async (method, path, { body, device = 'farmer-1' } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-device-id': device },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};

const makeCenter = async (key, dLat, extra = {}) => {
  const op = `op-${key}`;
  await call('GET', '/v1/me', { device: op });
  const res = await call('POST', '/v1/admin/centers', {
    device: 'admin',
    body: { name: `Center ${key}`, village: key, latitude: BASE.latitude + dLat, longitude: BASE.longitude, operatorId: op, phone: `9${key}`, opensAt: '00:00', closesAt: '23:59', ...extra },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  centers[key] = { ...res.json, device: op };
};
const stock = (key, productId, quantity) => call('POST', '/v1/operator/inventory/receive', { device: centers[key].device, body: { productId, quantity } });
const nearby = (body, device) => call('POST', '/v1/centers/nearby', { body, device });
const names = (res) => res.json.centers.map((c) => c.center.village);

test.before(async () => {
  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  db = await openTestDb('t_nearby');
  const app = createApp(db);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  await makeCenter('c1', 0.02); //  ~2.2 km north of BASE
  await makeCenter('c2', 0.05); //  ~5.6 km
  await makeCenter('mid', 0.15); // ~16.7 km
  await makeCenter('far', 0.28); // ~31 km
  await makeCenter('out', 0.5); //  ~55 km: beyond every radius
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

test('a location is required and validated', async () => {
  assert.equal((await nearby({})).status, 400);
  assert.equal((await nearby({ latitude: 95, longitude: 74 })).status, 400);
  assert.equal((await nearby({ latitude: 18.5 })).status, 400);
  assert.equal((await nearby({ latitude: 18.5, longitude: 74, locationSource: 'telepathy' })).status, 400);
  assert.equal((await nearby({ village: 'Atlantis' })).status, 404);
  assert.equal((await nearby({ ...BASE, items: [{ productId: 'nope', quantity: 1 }] })).status, 404);
  assert.equal((await nearby({ ...BASE, items: [{ productId: 'p-neemcake', quantity: 0 }] })).status, 400);
  assert.equal((await nearby({ ...BASE, items: 'x' })).status, 400);
  assert.equal((await nearby({ ...BASE, limit: 0 })).status, 400);
});

test('adaptive radius: 10 km when two are close, widening to 20 then 35 only when needed', async () => {
  const tight = await nearby(BASE);
  assert.equal(tight.status, 200);
  assert.equal(tight.json.radiusKm, 10);
  assert.deepEqual(names(tight).sort(), ['c1', 'c2']);

  // One center within 10 km is not enough: widen to 20 (which also pulls in more).
  const widened = await nearby(at(0.16));
  assert.equal(widened.json.radiusKm, 20);
  assert.deepEqual(names(widened).sort(), ['c1', 'c2', 'far', 'mid']);

  // From the south only c1 and c2 are inside 35 km.
  const widest = await nearby(at(-0.2));
  assert.equal(widest.json.radiusKm, 35);
  assert.deepEqual(names(widest).sort(), ['c1', 'c2']);

  const nowhere = await nearby({ latitude: 0, longitude: 0 });
  assert.equal(nowhere.json.radiusKm, 35);
  assert.deepEqual(nowhere.json.centers, []);
});

test('each card has what the farmer needs to decide', async () => {
  const res = await nearby(BASE);
  const top = res.json.centers[0];
  assert.deepEqual(res.json.location, { ...BASE, source: 'gps' });
  assert.equal(top.center.village, 'c1');
  assert.equal(top.center.phone, '9c1');
  assert.equal(top.center.operatorName, '');
  assert.equal(top.center.rating, null);
  near(top.distanceKm, 2.2, 0.1);
  assert.equal(top.travelTimeIsEstimate, true);
  assert.ok(top.estimatedTravelMinutes >= 1);
  assert.equal(top.hours.isOpenNow, true);
  assert.equal(top.pendingPickups, 0);
  assert.deepEqual(Object.keys(top.scores).sort(), ['distance', 'historical', 'inventory', 'operational', 'total']);
  assert.equal(top.scores.historical, 50);
  assert.equal(top.inventory.status, null, 'no cart, no inventory verdict');
  assert.equal(top.isRecommended, true);
  assert.equal(res.json.centers[1].isRecommended, false);
  assert.equal(top.recommendationReason, 'Closest open center');
  assert.equal(res.json.centers[1].recommendationReason, undefined);
});

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected} +/- ${tolerance}, got ${actual}`);
}

test('stock decides: a farther center with everything beats a closer one with nothing', async () => {
  const cart = [{ productId: 'p-neemcake', quantity: 2 }, { productId: 'p-sprayer', quantity: 1 }];
  const before = await nearby({ ...BASE, items: cart });
  assert.ok(before.json.centers.every((c) => c.inventory.status === 'none'));
  assert.equal(before.json.centers[0].inventory.label, 'Out of stock for your order');
  assert.match(before.json.centers[0].recommendationReason, /none of your items are in stock/);

  await stock('c2', 'p-neemcake', 5);
  await stock('c2', 'p-sprayer', 3);
  const res = await nearby({ ...BASE, items: cart });
  assert.deepEqual(names(res), ['c2', 'c1']);
  assert.equal(res.json.centers[0].inventory.status, 'all');
  assert.equal(res.json.centers[0].inventory.label, 'All items available');
  assert.equal(res.json.centers[0].recommendationReason, 'Closest center with all your items in stock');
  assert.equal(res.json.centers[1].inventory.label, 'Out of stock for your order');
  assert.deepEqual(res.json.centers[0].inventory.items.map((i) => [i.productId, i.requested, i.available]), [['p-neemcake', 2, 5], ['p-sprayer', 1, 3]]);
});

test('reserved stock is not available, and partial cover is reported honestly', async () => {
  const cart = [{ productId: 'p-neemcake', quantity: 2 }, { productId: 'p-sprayer', quantity: 1 }];
  await db.query("UPDATE center_inventory SET reserved = 4 WHERE product_id = 'p-neemcake' AND center_id = $1", [centers.c2.centerId]);
  const res = await nearby({ ...BASE, items: cart });
  const c2 = res.json.centers.find((c) => c.center.village === 'c2');
  assert.equal(c2.inventory.items[0].available, 1, '5 on hand, 4 reserved');
  assert.equal(c2.inventory.status, 'partial');
  assert.equal(c2.inventory.label, '1 of 2 items available');
  assert.equal(res.json.centers[0].center.village, 'c2', 'still ahead of the center with nothing');
  assert.equal(res.json.centers[0].recommendationReason, '5.6 km away, 1 of 2 items available');

  // The same product asked for twice is one line.
  const merged = await nearby({ ...BASE, items: [{ productId: 'p-sprayer', quantity: 1 }, { productId: 'p-sprayer', quantity: 1 }] });
  assert.equal(merged.json.centers.find((c) => c.center.village === 'c2').inventory.items.length, 1);
  assert.equal(merged.json.centers.find((c) => c.center.village === 'c2').inventory.items[0].requested, 2);
  await db.query('UPDATE center_inventory SET reserved = 0');
});

test('a closed center drops down; pending pickups are counted', async () => {
  assert.equal((await nearby(BASE)).json.centers[0].center.village, 'c1');
  const closed = await call('PATCH', '/v1/operator/center', { device: centers.c1.device, body: { isOpen: false } });
  assert.equal(closed.json.isOpen, false);
  const res = await nearby(BASE);
  assert.equal(res.json.centers[0].center.village, 'c2', 'open beats slightly closer');
  const c1 = res.json.centers.find((c) => c.center.village === 'c1');
  assert.equal(c1.hours.isOpenNow, false);
  assert.equal(c1.hours.label, 'Closed by operator');
  await call('PATCH', '/v1/operator/center', { device: centers.c1.device, body: { isOpen: true } });

  await call('POST', '/v1/orders', { device: 'buyer', body: { centerId: centers.c2.centerId, items: [{ productId: 'p-neemcake', quantity: 1 }] } });
  const busy = await nearby(BASE);
  assert.equal(busy.json.centers.find((c) => c.center.village === 'c2').pendingPickups, 1);
  assert.equal(busy.json.centers.find((c) => c.center.village === 'c1').pendingPickups, 0);
});

test('a home center gets a bonus that can flip a close call, and says so', async () => {
  assert.equal((await nearby(BASE)).json.centers[0].center.village, 'c1');
  assert.equal((await call('PUT', '/v1/farmer/profile', { device: 'homer', body: { homeCenterId: 'nope' } })).status, 404);
  const saved = await call('PUT', '/v1/farmer/profile', { device: 'homer', body: { homeCenterId: centers.c2.centerId } });
  assert.equal(saved.json.homeCenterId, centers.c2.centerId);

  const res = await nearby(BASE, 'homer');
  assert.equal(res.json.centers[0].center.village, 'c2');
  assert.equal(res.json.centers[0].isHomeCenter, true);
  assert.match(res.json.centers[0].recommendationReason, /^Your home center: /);
  assert.equal(res.json.centers[1].isHomeCenter, false);
  // Someone else's home center does not leak into this farmer's ranking.
  assert.equal((await nearby(BASE, 'stranger')).json.centers[0].center.village, 'c1');

  assert.equal((await call('PUT', '/v1/farmer/profile', { device: 'homer', body: { homeCenterId: null } })).json.homeCenterId, null);
});

test('centers that cannot serve anyone are never offered: suspended or without an operator', async () => {
  await makeCenter('ghost', 0.03);
  assert.ok(names(await nearby(BASE)).includes('ghost'));
  await call('PATCH', `/v1/admin/centers/${centers.ghost.centerId}`, { device: 'admin', body: { status: 'suspended' } });
  assert.ok(!names(await nearby(BASE)).includes('ghost'));
  await call('PATCH', `/v1/admin/centers/${centers.ghost.centerId}`, { device: 'admin', body: { status: 'active' } });
  await call('PUT', `/v1/admin/centers/${centers.ghost.centerId}/operator`, { device: 'admin', body: { userId: null } });
  assert.ok(!names(await nearby(BASE)).includes('ghost'));
});

test('location can come from GPS, a pin, a village, or the saved profile', async () => {
  const pin = await nearby({ ...BASE, locationSource: 'pin' });
  assert.equal(pin.json.location.source, 'pin');

  const village = await nearby({ village: 'Shirur, Pune' });
  assert.equal(village.json.location.source, 'village');
  near(village.json.location.latitude, 18.8284, 0.001);

  // Nothing saved yet for this farmer: no location at all is an error.
  assert.equal((await nearby({}, 'fresh')).status, 400);

  // Saved GPS is reused when the app sends no location.
  await nearby({ ...BASE, saveToProfile: true }, 'fresh');
  const profile = (await call('GET', '/v1/farmer/profile', { device: 'fresh' })).json;
  assert.deepEqual([profile.latitude, profile.longitude, profile.locationSource], [BASE.latitude, BASE.longitude, 'gps']);
  const reused = await nearby({}, 'fresh');
  assert.equal(reused.json.location.source, 'gps');
  assert.equal(reused.json.centers[0].center.village, 'c1');

  // Registered village is the last resort.
  await call('PUT', '/v1/farmer/profile', { device: 'villager', body: { village: 'Baramati, Pune' } });
  const fallback = await nearby({}, 'villager');
  assert.equal(fallback.json.location.source, 'village');
  near(fallback.json.location.latitude, 18.1514, 0.001);

  // A village lookup is never persisted as if it were a GPS fix.
  await nearby({ village: 'Shirur', saveToProfile: true }, 'villager');
  assert.equal((await call('GET', '/v1/farmer/profile', { device: 'villager' })).json.latitude, null);
});

test('profile location is validated as a pair and can be cleared', async () => {
  const put = (body) => call('PUT', '/v1/farmer/profile', { device: 'pairs', body });
  assert.equal((await put({ latitude: 18.5 })).status, 400);
  assert.equal((await put({ latitude: 18.5, longitude: 200 })).status, 400);
  const ok = await put({ latitude: 18.5, longitude: 74, locationSource: 'pin' });
  assert.deepEqual([ok.json.latitude, ok.json.longitude, ok.json.locationSource], [18.5, 74, 'pin']);
  const cleared = await put({ latitude: null, longitude: null });
  assert.deepEqual([cleared.json.latitude, cleared.json.longitude, cleared.json.locationSource], [null, null, null]);
});

test('limit trims the list, and the village directory is searchable', async () => {
  const two = await nearby({ ...at(0.16), limit: 2 });
  assert.equal(two.json.centers.length, 2);
  assert.equal(two.json.centers.filter((c) => c.isRecommended).length, 1);
  const list = await call('GET', '/v1/centers/villages?q=shir');
  assert.ok(list.json.some((v) => v.name === 'Shirur'));
  assert.ok(list.json.every((v) => typeof v.latitude === 'number'));
});
