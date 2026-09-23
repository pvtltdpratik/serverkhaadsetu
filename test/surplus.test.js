process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');

// Surplus lots: an operator lists units below the catalog price, apart from the
// regular shelf (anonymous X-Device-Id mode).
const BASE = { latitude: 18.5, longitude: 74.0 };
const NEEM = 'p-neemcake'; // catalog price Rs 600

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
  return { status: res.status, json: text ? JSON.parse(text) : null };
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
const receive = (c, quantity) => call('POST', '/v1/operator/inventory/receive', { device: c.device, body: { productId: NEEM, quantity } });
const shelf = async (c) => (await call('GET', '/v1/operator/inventory/items', { device: c.device })).json.find((i) => i.id === NEEM);
const list = async (c, query = '') => (await call('GET', `/v1/operator/surplus${query}`, { device: c.device })).json;
const create = (c, body) => call('POST', '/v1/operator/surplus', { device: c.device, body: { productId: NEEM, quantity: 5, unitPrice: 400, condition: 'near_expiry', ...body } });
// Days are counted in the center's time zone, as the server does.
const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

test.before(async () => {
  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  db = await openTestDb('t_surplus');
  const app = createApp(db);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

test('an operator lists surplus from outside the supply chain; the shelf is untouched', async () => {
  const c = await makeCenter('ext');
  await receive(c, 10);
  const res = await create(c, { quantity: 4, unitPrice: 450, condition: 'returned', bestBefore: daysFromNow(30), note: 'Bought back from a farmer' });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.productName, 'Neem Cake');
  assert.equal(res.json.unitPrice, 450);
  assert.equal(res.json.catalogPrice, 600);
  assert.equal(res.json.discountPercent, 25);
  assert.equal(res.json.available, 4);
  assert.equal(res.json.status, 'active');
  assert.equal(res.json.fromShelf, false);
  assert.equal(res.json.note, 'Bought back from a farmer');
  assert.equal((await shelf(c)).currentStock, 10, 'the regular shelf is not affected');
  assert.equal((await list(c)).length, 1);
});

test('marking down from the shelf moves units off it, and only what is not already reserved', async () => {
  const c = await makeCenter('shelf');
  await receive(c, 10);
  await call('POST', '/v1/orders', { device: 'farmer-1', body: { centerId: c.centerId, items: [{ productId: NEEM, quantity: 4 }] } }); // 4 reserved, 6 available

  const tooMany = await create(c, { quantity: 7, fromShelf: true });
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.json.error.message ?? tooMany.json.error, /Only 6/);
  assert.equal((await shelf(c)).currentStock, 10, 'a refused mark-down changes nothing');
  assert.equal((await list(c)).length, 0);

  const ok = await create(c, { quantity: 6, fromShelf: true });
  assert.equal(ok.status, 201);
  const item = await shelf(c);
  assert.equal(item.currentStock, 4);
  assert.equal(item.available, 0);
});

test('withdrawing a marked-down lot puts the unsold units back on the shelf', async () => {
  const c = await makeCenter('back');
  await receive(c, 10);
  const lot = (await create(c, { quantity: 6, fromShelf: true })).json;
  assert.equal((await shelf(c)).currentStock, 4);

  const res = await call('POST', `/v1/operator/surplus/${lot.id}/withdraw`, { device: c.device });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'withdrawn');
  assert.equal((await shelf(c)).currentStock, 10);
  assert.equal((await call('POST', `/v1/operator/surplus/${lot.id}/withdraw`, { device: c.device })).status, 409, 'cannot withdraw twice');
});

test('withdrawing an outside-sourced lot does not invent shelf stock', async () => {
  const c = await makeCenter('noinvent');
  await receive(c, 3);
  const lot = (await create(c, { quantity: 5 })).json;
  await call('POST', `/v1/operator/surplus/${lot.id}/withdraw`, { device: c.device });
  assert.equal((await shelf(c)).currentStock, 3);
});

test('withdrawing that would overfill the shelf is refused and the lot stays on sale', async () => {
  const c = await makeCenter('cap');
  await receive(c, 10);
  const lot = (await create(c, { quantity: 6, fromShelf: true })).json; // shelf 4
  await call('PATCH', `/v1/operator/inventory/items/${NEEM}`, { device: c.device, body: { maxCapacity: 8 } });
  await receive(c, 4); // shelf back to 8, full
  const res = await call('POST', `/v1/operator/surplus/${lot.id}/withdraw`, { device: c.device });
  assert.equal(res.status, 409);
  assert.equal((await list(c, '?status=active')).length, 1);
  assert.equal((await shelf(c)).currentStock, 8);
});

test('the surplus price must be below the regular price', async () => {
  const c = await makeCenter('price');
  for (const unitPrice of [600, 750]) {
    const res = await create(c, { unitPrice });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message ?? res.json.error, /lower than the regular price/);
  }
  assert.equal((await create(c, { unitPrice: 0 })).status, 201, 'free is allowed: it is still lower');
});

test('validation: condition, quantity, dates, unknown product', async () => {
  const c = await makeCenter('valid');
  assert.equal((await create(c, { condition: 'stolen' })).status, 400);
  assert.equal((await create(c, { quantity: 0 })).status, 400);
  assert.equal((await create(c, { quantity: 1.5 })).status, 400);
  assert.equal((await create(c, { bestBefore: 'next week' })).status, 400);
  assert.equal((await create(c, { bestBefore: '2026-02-30' })).status, 400);
  assert.equal((await create(c, { bestBefore: daysFromNow(-2) })).status, 400, 'already past');
  assert.equal((await create(c, { bestBefore: daysFromNow(0) })).status, 201, 'today is still sellable');
  assert.equal((await create(c, { productId: 'p-nope' })).status, 404);
  assert.equal((await create(c, { fromShelf: 'yes' })).status, 400);
});

test('an operator can lower the price and reword a lot, but not raise it to the regular price or edit a withdrawn lot', async () => {
  const c = await makeCenter('edit');
  const lot = (await create(c, {})).json;
  const res = await call('PATCH', `/v1/operator/surplus/${lot.id}`, { device: c.device, body: { unitPrice: 300, note: 'Clearance' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.unitPrice, 300);
  assert.equal(res.json.discountPercent, 50);
  assert.equal(res.json.note, 'Clearance');
  assert.equal((await call('PATCH', `/v1/operator/surplus/${lot.id}`, { device: c.device, body: { unitPrice: 600 } })).status, 400);
  assert.equal((await call('PATCH', `/v1/operator/surplus/${lot.id}`, { device: c.device, body: {} })).status, 400);
  await call('POST', `/v1/operator/surplus/${lot.id}/withdraw`, { device: c.device });
  assert.equal((await call('PATCH', `/v1/operator/surplus/${lot.id}`, { device: c.device, body: { unitPrice: 200 } })).status, 409);
});

test('an operator only sees and changes their own center\'s lots', async () => {
  const a = await makeCenter('mine');
  const b = await makeCenter('theirs');
  const lot = (await create(a, {})).json;
  assert.equal((await list(b)).length, 0);
  assert.equal((await call('PATCH', `/v1/operator/surplus/${lot.id}`, { device: b.device, body: { unitPrice: 100 } })).status, 404);
  assert.equal((await call('POST', `/v1/operator/surplus/${lot.id}/withdraw`, { device: b.device })).status, 404);
  assert.equal((await list(a)).length, 1);
});

test('lots list newest first, filter by status, and show expired ones as expired', async () => {
  const c = await makeCenter('list');
  const first = (await create(c, { note: 'first' })).json;
  const second = (await create(c, { note: 'second' })).json;
  await call('POST', `/v1/operator/surplus/${first.id}/withdraw`, { device: c.device });
  // A lot whose best-before date has passed since it was listed.
  await db.query(`UPDATE surplus_lot SET best_before = CURRENT_DATE - 3 WHERE id = $1`, [second.id]);

  const all = await list(c);
  assert.deepEqual(all.map((l) => l.note), ['second', 'first']);
  assert.equal(all.find((l) => l.id === second.id).status, 'expired');
  assert.equal((await list(c, '?status=withdrawn')).length, 1);
  assert.equal((await call('GET', '/v1/operator/surplus?status=bogus', { device: c.device })).status, 400);
});

test('only an operator can use the surplus API', async () => {
  assert.equal((await call('GET', '/v1/operator/surplus', { device: 'just-a-farmer' })).status, 403);
  assert.equal((await call('POST', '/v1/operator/surplus', { device: 'just-a-farmer', body: { productId: NEEM, quantity: 1, unitPrice: 1, condition: 'other' } })).status, 403);
});
