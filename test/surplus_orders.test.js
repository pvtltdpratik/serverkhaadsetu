process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');

// Surplus lots from the farmer's side: finding them nearby, buying one with the
// same reserve-for-pickup flow, and what happens to the units when an order is
// cancelled, expires, is collected, or its center goes offline.
const NEEM = 'p-neemcake'; // Rs 600
const UREA = 'p-vermicompost';
const DAY = 24 * 60 * 60 * 1000;

let server;
let base;
let db;
let counter = 0;
let runMaintenance;
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
// The maintenance job holds a database-wide advisory lock, and test files run in
// parallel against one database, so another file's run can make ours skip.
// Retry until it really ran.
const runJob = async (job, now) => {
  for (let i = 0; i < 50; i += 1) {
    const result = await job(db, now);
    if (!result.skipped) return result;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('the job never got the lock');
};
const errorText = (res) => res.json?.error?.message ?? res.json?.error ?? '';

// A center `dLat` degrees north of the farmer's spot (0.01 deg is about 1.1 km).
const makeCenter = async (key, dLat = 0) => {
  counter += 1;
  const op = `op-${key}-${counter}`;
  await call('GET', '/v1/me', { device: op });
  const res = await call('POST', '/v1/admin/centers', {
    device: 'admin',
    body: { name: `Center ${key}`, village: key, latitude: 18.5 + dLat, longitude: 74.0, operatorId: op, opensAt: '00:00', closesAt: '23:59' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { ...res.json, device: op };
};
const receive = (c, quantity, productId = NEEM) => call('POST', '/v1/operator/inventory/receive', { device: c.device, body: { productId, quantity } });
const shelf = async (c, productId = NEEM) => (await call('GET', '/v1/operator/inventory/items', { device: c.device })).json.find((i) => i.id === productId);
const lotOf = async (c, id) => (await call('GET', '/v1/operator/surplus', { device: c.device })).json.find((l) => l.id === id);
const makeLot = async (c, extra = {}) => {
  const res = await call('POST', '/v1/operator/surplus', {
    device: c.device,
    body: { productId: NEEM, quantity: 5, unitPrice: 400, condition: 'near_expiry', ...extra },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
};
const nearby = (body = {}, device = 'farmer-1') => call('POST', '/v1/centers/surplus', { device, body: { latitude: 18.5, longitude: 74.0, ...body } });
const buy = (lotId, quantity, { device = 'farmer-1', extra = [], centerId } = {}) =>
  call('POST', '/v1/orders', { device, body: { ...(centerId ? { centerId } : {}), latitude: 18.5, longitude: 74.0, items: [{ surplusLotId: lotId, quantity }, ...extra] } });

test.before(async () => {
  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  ({ runReservationMaintenance: runMaintenance } = require('../src/services/reservationJobs'));
  ({ runReassignment } = require('../src/services/reassignment'));
  db = await openTestDb('t_surplus_orders');
  const app = createApp(db);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

test('nearby surplus: lots come nearest first with the discount and the center, and only live ones', async () => {
  const near = await makeCenter('sn-near', 0.01);
  const far = await makeCenter('sn-far', 0.1);
  const way = await makeCenter('sn-way', 0.6); // ~66 km: out of range
  const nearLot = await makeLot(near, { unitPrice: 450, note: 'Torn bags, contents fine' });
  const farLot = await makeLot(far, { unitPrice: 300 });
  await makeLot(way);
  const withdrawn = await makeLot(near);
  await call('POST', `/v1/operator/surplus/${withdrawn.id}/withdraw`, { device: near.device });
  const expired = await makeLot(near);
  await db.query('UPDATE surplus_lot SET best_before = CURRENT_DATE - 5 WHERE id = $1', [expired.id]);
  const soldOut = await makeLot(far, { quantity: 1 });
  await buy(soldOut.id, 1, { device: 'sn-buyer' });

  const res = await nearby({ productId: NEEM });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const ids = res.json.lots.map((l) => l.id).filter((id) => [nearLot.id, farLot.id, withdrawn.id, expired.id, soldOut.id, way].includes(id));
  assert.deepEqual(ids, [nearLot.id, farLot.id], 'nearest first; withdrawn, expired, sold-out and out-of-range are not offered');

  const first = res.json.lots.find((l) => l.id === nearLot.id);
  assert.equal(first.unitPrice, 450);
  assert.equal(first.catalogPrice, 600);
  assert.equal(first.discountPercent, 25);
  assert.equal(first.available, 5);
  assert.equal(first.condition, 'near_expiry');
  assert.equal(first.note, 'Torn bags, contents fine');
  assert.equal(first.center.centerId, near.centerId);
  assert.equal(first.center.name, 'Center sn-near');
  assert.ok(first.distanceKm > 0 && first.distanceKm < 3);
  assert.equal(first.travelTimeIsEstimate, true);
  assert.ok(res.json.lots.every((l) => l.status === 'active'));
});

test('nearby surplus: narrows by product, and needs a location', async () => {
  const c = await makeCenter('sn-prod', 0.02);
  const urea = await makeLot(c, { productId: UREA, unitPrice: 1 });
  const neem = await makeLot(c);
  const ureaOnly = (await nearby({ productId: UREA })).json.lots.map((l) => l.id);
  assert.ok(ureaOnly.includes(urea.id) && !ureaOnly.includes(neem.id));
  const nowhere = await call('POST', '/v1/centers/surplus', { device: 'no-location-farmer', body: {} });
  assert.equal(nowhere.status, 400);
  assert.equal((await nearby({ radiusKm: 0 })).status, 400);
});

test('nearby surplus: a suspended center offers nothing', async () => {
  const c = await makeCenter('sn-susp', 0.03);
  const lot = await makeLot(c);
  await call('PATCH', `/v1/admin/centers/${c.centerId}`, { device: 'admin', body: { status: 'suspended' } });
  assert.ok(!(await nearby()).json.lots.some((l) => l.id === lot.id));
});

test('buying surplus: the price comes from the lot, the units are held, and the shelf is untouched', async () => {
  const c = await makeCenter('buy');
  await receive(c, 10);
  const lot = await makeLot(c, { quantity: 5, unitPrice: 420 });
  const res = await buy(lot.id, 2);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.centerId, c.centerId);
  assert.equal(res.json.items.length, 1);
  assert.equal(res.json.items[0].surplusLotId, lot.id);
  assert.equal(res.json.items[0].productName, 'Neem Cake');
  assert.equal(res.json.items[0].unitPrice, 420, 'the surplus price, not the catalog price');
  assert.equal(res.json.totalAmount, 840);
  assert.match(res.json.pickupOtp, /^\d{4}$/);

  const held = await lotOf(c, lot.id);
  assert.equal(held.reserved, 2);
  assert.equal(held.available, 3);
  const item = await shelf(c);
  assert.equal(item.currentStock, 10);
  assert.equal(item.reserved, 0, 'regular stock is not touched');
});

test('buying surplus: a price the client sends is ignored, and a lot that is not on sale is refused', async () => {
  const c = await makeCenter('cheat');
  const lot = await makeLot(c);
  const res = await call('POST', '/v1/orders', {
    device: 'farmer-1',
    body: { latitude: 18.5, longitude: 74.0, items: [{ surplusLotId: lot.id, quantity: 1, unitPrice: 1 }] },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.items[0].unitPrice, 400);

  const gone = await makeLot(c);
  await call('POST', `/v1/operator/surplus/${gone.id}/withdraw`, { device: c.device });
  const refused = await buy(gone.id, 1);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code ?? refused.json.code, 'surplus_unavailable');
  assert.equal((await buy('lot-does-not-exist', 1)).status, 409);
});

test('buying surplus: more than is left is refused and changes nothing', async () => {
  const c = await makeCenter('over');
  const lot = await makeLot(c, { quantity: 3 });
  assert.equal((await buy(lot.id, 4)).status, 409);
  assert.equal((await lotOf(c, lot.id)).reserved, 0);
  assert.equal((await buy(lot.id, 3)).status, 201);
  assert.equal((await buy(lot.id, 1, { device: 'late-farmer' })).status, 409, 'nothing left');
});

test('buying surplus: two farmers racing for the last units cannot both get them', async () => {
  const c = await makeCenter('race');
  const lot = await makeLot(c, { quantity: 4 });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => buy(lot.id, 2, { device: `racer-${i}` })));
  const won = results.filter((r) => r.status === 201).length;
  assert.equal(won, 2, 'only 4 units, 2 each');
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
  const after = await lotOf(c, lot.id);
  assert.equal(after.reserved, 4);
  assert.equal(after.available, 0);
});

test('a cart can mix surplus and regular stock at the same center, and a lot that sold out takes the shelf hold with it', async () => {
  const c = await makeCenter('mix');
  await receive(c, 10, UREA);
  const lot = await makeLot(c, { quantity: 2 });
  const ok = await buy(lot.id, 1, { extra: [{ productId: UREA, quantity: 3 }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.items.length, 2);
  assert.equal((await shelf(c, UREA)).reserved, 3);
  assert.equal((await lotOf(c, lot.id)).reserved, 1);

  // Ask for more surplus than is left, plus regular stock: the whole order fails
  // and the regular stock is not left held.
  const bad = await buy(lot.id, 5, { device: 'mixer-2', extra: [{ productId: UREA, quantity: 2 }] });
  assert.equal(bad.status, 409);
  assert.equal((await shelf(c, UREA)).reserved, 3, 'the failed order held nothing');
  assert.equal((await lotOf(c, lot.id)).reserved, 1);
});

test('surplus is collected from the center that listed it: mixed centers or a different chosen center are refused', async () => {
  const a = await makeCenter('pin-a');
  const b = await makeCenter('pin-b');
  const lotA = await makeLot(a);
  const lotB = await makeLot(b);
  const both = await call('POST', '/v1/orders', {
    device: 'farmer-1',
    body: { latitude: 18.5, longitude: 74.0, items: [{ surplusLotId: lotA.id, quantity: 1 }, { surplusLotId: lotB.id, quantity: 1 }] },
  });
  assert.equal(both.status, 400);
  assert.match(errorText(both), /different centers/);
  const wrongCenter = await buy(lotA.id, 1, { centerId: b.centerId });
  assert.equal(wrongCenter.status, 400);
  assert.equal((await buy(lotA.id, 1, { centerId: a.centerId })).status, 201);
});

test('cancelling an order gives its surplus units back to the lot', async () => {
  const c = await makeCenter('cancel');
  const lot = await makeLot(c, { quantity: 5 });
  const placed = (await buy(lot.id, 3)).json;
  assert.equal((await lotOf(c, lot.id)).available, 2);
  assert.equal((await call('POST', `/v1/orders/${placed.id}/cancel`)).status, 200);
  const after = await lotOf(c, lot.id);
  assert.equal(after.reserved, 0);
  assert.equal(after.available, 5);
  assert.equal(after.quantity, 5);
  // Cancelling again is refused and must not release twice.
  assert.equal((await call('POST', `/v1/orders/${placed.id}/cancel`)).status, 409);
  assert.equal((await lotOf(c, lot.id)).reserved, 0);
});

test('collecting an order takes its surplus units out of the lot for good; a lot that is all sold shows as sold out', async () => {
  const c = await makeCenter('collect');
  const lot = await makeLot(c, { quantity: 3 });
  const placed = (await buy(lot.id, 3, { device: 'collector' })).json;
  await call('POST', `/v1/operator/orders/${placed.id}/ready`, { device: c.device });
  const verify = await call('POST', `/v1/operator/orders/${placed.id}/verify-otp`, { device: c.device, body: { otp: placed.pickupOtp } });
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  const after = await lotOf(c, lot.id);
  assert.equal(after.quantity, 0);
  assert.equal(after.reserved, 0);
  assert.equal(after.status, 'soldOut');
});

test('an expired reservation releases its surplus units', async () => {
  const c = await makeCenter('expire');
  const lot = await makeLot(c, { quantity: 4 });
  const placed = (await buy(lot.id, 4, { device: 'no-show' })).json;
  assert.equal((await lotOf(c, lot.id)).available, 0);
  await runJob(runMaintenance, new Date(Date.now() + 5 * DAY + 60 * 1000));
  assert.equal((await call('GET', `/v1/orders/${placed.id}`, { device: 'no-show' })).json.status, 'cancelled');
  assert.equal((await lotOf(c, lot.id)).available, 4);
});

test('withdrawing a lot while an order holds units: they stay until the order ends, then return to the shelf if they came from it', async () => {
  const c = await makeCenter('held');
  await receive(c, 10);
  const lot = await makeLot(c, { quantity: 6, fromShelf: true }); // shelf 4
  const placed = (await buy(lot.id, 2, { device: 'holder' })).json;
  const withdrawn = (await call('POST', `/v1/operator/surplus/${lot.id}/withdraw`, { device: c.device })).json;
  assert.equal(withdrawn.quantity, 2, 'only the held units remain in the lot');
  assert.equal((await shelf(c)).currentStock, 8, 'the 4 unsold units are back on the shelf');

  await call('POST', `/v1/orders/${placed.id}/cancel`, { device: 'holder' });
  assert.equal((await shelf(c)).currentStock, 10, 'the held units follow once the order is cancelled');
  const after = await lotOf(c, lot.id);
  assert.equal(after.quantity, 0);
  assert.equal(after.reserved, 0);
});

test('a withdrawn lot\'s held units are written off, not an error, if the shelf has filled up meanwhile', async () => {
  const c = await makeCenter('full');
  await receive(c, 10);
  const lot = await makeLot(c, { quantity: 6, fromShelf: true });
  const placed = (await buy(lot.id, 2, { device: 'holder-2' })).json;
  await call('POST', `/v1/operator/surplus/${lot.id}/withdraw`, { device: c.device }); // shelf back to 8
  await call('PATCH', `/v1/operator/inventory/items/${NEEM}`, { device: c.device, body: { maxCapacity: 8 } });
  const cancelled = await call('POST', `/v1/orders/${placed.id}/cancel`, { device: 'holder-2' });
  assert.equal(cancelled.status, 200, 'the cancel itself must not fail');
  assert.equal((await shelf(c)).currentStock, 8);
});

test('an order holding surplus is not moved to another center when its center goes offline', async () => {
  const a = await makeCenter('re-a', 0);
  const b = await makeCenter('re-b', 0.05);
  await receive(a, 5);
  await receive(b, 5);
  const lot = await makeLot(a, { quantity: 3 });
  const surplusOrder = (await buy(lot.id, 1, { device: 'stay-put' })).json;
  const regularOrder = (await call('POST', '/v1/orders', { device: 'mover', body: { centerId: a.centerId, latitude: 18.5, longitude: 74.0, items: [{ productId: NEEM, quantity: 1 }] } })).json;

  await call('PATCH', '/v1/operator/center', { device: a.device, body: { isOpen: false } });
  const run = await runJob((d, now) => runReassignment(d, { now }), new Date(Date.now() + 40 * 60000));
  assert.ok(run.moved >= 1);
  const centerOf = async (id) => (await db.query('SELECT center_id FROM orders WHERE id = $1', [id])).rows[0].center_id;
  assert.notEqual(await centerOf(regularOrder.id), a.centerId, 'a regular order moves to whichever center ranks best');
  assert.equal(await centerOf(surplusOrder.id), a.centerId, 'the surplus order stays with the lot');
  assert.equal((await lotOf(a, lot.id)).reserved, 1);
});

test('the admin overview counts what surplus is on sale', async () => {
  const before = (await call('GET', '/v1/admin/overview', { device: 'admin' })).json.surplus;
  const c = await makeCenter('admin-count');
  await makeLot(c, { quantity: 7 });
  const dead = await makeLot(c, { quantity: 9 });
  await call('POST', `/v1/operator/surplus/${dead.id}/withdraw`, { device: c.device });
  const after = (await call('GET', '/v1/admin/overview', { device: 'admin' })).json.surplus;
  assert.equal(after.activeLots, before.activeLots + 1);
  assert.equal(after.units, before.units + 7);
});

test('admin: sees every center\'s lots and can filter them', async () => {
  const a = await makeCenter('adm-a');
  const b = await makeCenter('adm-b');
  const lotA = await makeLot(a, { note: 'from a' });
  const lotB = await makeLot(b, { note: 'from b' });
  await call('POST', `/v1/operator/surplus/${lotB.id}/withdraw`, { device: b.device });

  const all = await call('GET', '/v1/admin/surplus?limit=200', { device: 'admin' });
  assert.equal(all.status, 200);
  const mine = all.json.filter((l) => [lotA.id, lotB.id].includes(l.id));
  assert.equal(mine.length, 2);
  assert.equal(mine.find((l) => l.id === lotA.id).centerName, 'Center adm-a');
  assert.equal(mine.find((l) => l.id === lotA.id).discountPercent, 33);

  const byCenter = (await call('GET', `/v1/admin/surplus?centerId=${b.centerId}`, { device: 'admin' })).json;
  assert.deepEqual(byCenter.map((l) => l.id), [lotB.id]);
  const active = (await call('GET', `/v1/admin/surplus?status=active&centerId=${b.centerId}`, { device: 'admin' })).json;
  assert.equal(active.length, 0);
  assert.equal((await call('GET', '/v1/admin/surplus?status=bogus', { device: 'admin' })).status, 400);
});

test('admin: withdrawing a lot tells the operator why, is audited, and is refused twice', async () => {
  const c = await makeCenter('adm-wd');
  await receive(c, 10);
  const lot = await makeLot(c, { quantity: 6, fromShelf: true });
  const res = await call('POST', `/v1/admin/surplus/${lot.id}/withdraw`, { device: 'admin', body: { reason: 'Past its date' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.status, 'withdrawn');
  assert.equal((await shelf(c)).currentStock, 10, 'shelf units go back, as with an operator withdrawal');

  const alerts = (await call('GET', '/v1/farmer/notifications', { device: c.device })).json.filter((n) => n.title === 'A surplus offer was withdrawn');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].body, /Past its date/);
  assert.equal(alerts[0].refId, lot.id);

  const audit = (await call('GET', `/v1/admin/audit?targetType=surplus&targetId=${lot.id}`, { device: 'admin' })).json;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'surplus.withdraw');
  assert.equal(audit[0].details.reason, 'Past its date');

  assert.equal((await call('POST', `/v1/admin/surplus/${lot.id}/withdraw`, { device: 'admin' })).status, 409);
  assert.equal((await call('POST', '/v1/admin/surplus/lot-nope/withdraw', { device: 'admin' })).status, 404);
});

const walkIn = (c, items) => call('POST', '/v1/operator/orders/walk-in', { device: c.device, body: { items } });

test('walk-in: selling surplus at the counter takes units off the lot, at the lot price unless the operator sets one', async () => {
  const c = await makeCenter('walk');
  await receive(c, 10);
  const lot = await makeLot(c, { quantity: 6, unitPrice: 420 });

  const res = await walkIn(c, [{ surplusLotId: lot.id, quantity: 2 }]);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.type, 'walkIn');
  assert.equal(res.json.status, 'completed');
  assert.equal(res.json.items[0].surplusLotId, lot.id);
  assert.equal(res.json.items[0].productName, 'Neem Cake');
  assert.equal(res.json.items[0].unitPrice, 420, 'defaults to the surplus price');
  assert.equal(res.json.totalAmount, 840);

  const after = await lotOf(c, lot.id);
  assert.equal(after.quantity, 4);
  assert.equal(after.available, 4);
  assert.equal((await shelf(c)).currentStock, 10, 'the regular shelf is untouched');

  const haggled = await walkIn(c, [{ surplusLotId: lot.id, quantity: 1, unitPrice: 300 }]);
  assert.equal(haggled.json.items[0].unitPrice, 300, 'the operator can still set a price');
});

test('walk-in: cannot take units an app order is holding, and a refusal changes nothing (shelf lines included)', async () => {
  const c = await makeCenter('walk-held');
  await receive(c, 10);
  const lot = await makeLot(c, { quantity: 5 });
  await buy(lot.id, 4, { device: 'online-buyer' }); // 1 free

  const res = await walkIn(c, [{ productId: NEEM, quantity: 3, unitPrice: 600 }, { surplusLotId: lot.id, quantity: 2 }]);
  assert.equal(res.status, 409);
  assert.match(errorText(res), /Only 1 of the surplus Neem Cake available \(4 more reserved for app orders\)/);
  assert.equal((await shelf(c)).currentStock, 10, 'the shelf line was not taken either');
  assert.equal((await lotOf(c, lot.id)).quantity, 5);
});

test('walk-in: a mixed counter sale takes from both the shelf and the lot', async () => {
  const c = await makeCenter('walk-mixed');
  await receive(c, 10);
  const lot = await makeLot(c, { quantity: 3 });
  const res = await walkIn(c, [{ productId: NEEM, quantity: 2, unitPrice: 600 }, { surplusLotId: lot.id, quantity: 3 }]);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal((await shelf(c)).currentStock, 8);
  const after = await lotOf(c, lot.id);
  assert.equal(after.quantity, 0);
  assert.equal(after.status, 'soldOut');
});

test('walk-in: another center\'s lot, a withdrawn lot and an expired lot are refused', async () => {
  const mine = await makeCenter('walk-a');
  const other = await makeCenter('walk-b');
  const theirs = await makeLot(other);
  assert.equal((await walkIn(mine, [{ surplusLotId: theirs.id, quantity: 1 }])).status, 404);
  assert.equal((await walkIn(mine, [{ surplusLotId: 'lot-nope', quantity: 1 }])).status, 404);

  const gone = await makeLot(mine);
  await call('POST', `/v1/operator/surplus/${gone.id}/withdraw`, { device: mine.device });
  const withdrawn = await walkIn(mine, [{ surplusLotId: gone.id, quantity: 1 }]);
  assert.equal(withdrawn.status, 409);
  assert.match(errorText(withdrawn), /no longer on sale/);

  const old = await makeLot(mine);
  await db.query('UPDATE surplus_lot SET best_before = CURRENT_DATE - 3 WHERE id = $1', [old.id]);
  const expired = await walkIn(mine, [{ surplusLotId: old.id, quantity: 1 }]);
  assert.equal(expired.status, 409);
  assert.match(errorText(expired), /past its best-before date/);
});

test('walk-in: a counter sale and an online reservation racing for the last unit cannot both win', async () => {
  const c = await makeCenter('walk-race');
  const lot = await makeLot(c, { quantity: 1 });
  const [counter, online] = await Promise.all([walkIn(c, [{ surplusLotId: lot.id, quantity: 1 }]), buy(lot.id, 1, { device: 'racer' })]);
  assert.equal([counter, online].filter((r) => r.status === 201).length, 1, JSON.stringify([counter.status, online.status]));
  const after = await lotOf(c, lot.id);
  assert.ok(after.quantity - after.reserved >= 0);
});
