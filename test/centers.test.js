process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = require('jose');

// Roles and per-center scoping, exercised with real signed tokens: the point
// of these tests is that authority comes from the server, never from what a
// client claims about itself.

const SUPABASE = 'https://test-project.supabase.co';
const ADMIN_EMAIL = 'boss@example.com';

let server;
let base;
let db;
let key;

const token = (sub, { email = `${sub}@example.com`, meta = {} } = {}) =>
  new SignJWT({ role: 'authenticated', email, user_metadata: meta })
    .setProtectedHeader({ alg: 'ES256', kid: 'k' })
    .setSubject(sub)
    .setIssuer(`${SUPABASE}/auth/v1`)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);

const call = async (method, path, { body, as } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(as ? { authorization: `Bearer ${as}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};

let admin;
let opA;
let opB;
let farmer;
const centerBody = (over = {}) => ({ name: 'Kendra', village: 'Shirur', district: 'Pune', latitude: 18.83, longitude: 74.38, ...over });

test.before(async () => {
  const pair = await generateKeyPair('ES256');
  key = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k', alg: 'ES256', use: 'sig' };
  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  db = await openTestDb('t_centers');
  const app = createApp(db, {
    auth: { supabaseUrl: SUPABASE, jwks: createLocalJWKSet({ keys: [jwk] }) },
    superAdminEmails: [ADMIN_EMAIL],
  });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  admin = await token('admin-1', { email: ADMIN_EMAIL });
  opA = await token('op-a', { meta: { role: 'operator', full_name: 'Operator A' } });
  opB = await token('op-b', { meta: { role: 'operator' } });
  farmer = await token('farmer-1', { meta: { role: 'farmer' } });
  // Everyone signs in once, which records them.
  for (const t of [admin, opA, opB, farmer]) await call('GET', '/v1/me', { as: t });
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

test('nothing is seeded: no centers, and the operator-side tables start empty', async () => {
  assert.deepEqual((await call('GET', '/v1/admin/centers', { as: admin })).json, []);
  for (const table of ['center_inventory', 'restock_requests', 'farmers']) {
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM ${table}`)).n, 0, table);
  }
});

test('/me records the user and reports the server-decided role', async () => {
  const me = (await call('GET', '/v1/me', { as: opA })).json;
  assert.equal(me.name, 'Operator A');
  assert.equal(me.requestedRole, 'operator');
  assert.equal(me.role, 'farmer', 'asking to be an operator does not make you one');
  assert.equal(me.center, null);
  assert.equal((await call('GET', '/v1/me', { as: admin })).json.role, 'admin');
  assert.equal((await call('GET', '/v1/me', { as: farmer })).json.role, 'farmer');
  assert.equal((await call('GET', '/v1/me')).status, 401);
});

test('admin area is closed to everyone but listed administrators', async () => {
  for (const who of [farmer, opA]) {
    assert.equal((await call('GET', '/v1/admin/centers', { as: who })).status, 403);
    assert.equal((await call('POST', '/v1/admin/centers', { as: who, body: centerBody() })).status, 403);
    assert.equal((await call('GET', '/v1/admin/users', { as: who })).status, 403);
  }
  assert.equal((await call('GET', '/v1/admin/centers', { as: admin })).status, 200);
  // Claiming to be the admin in your own metadata changes nothing.
  const sneaky = await token('sneaky', { email: 'sneaky@example.com', meta: { role: 'admin', is_admin: true } });
  assert.equal((await call('GET', '/v1/admin/centers', { as: sneaky })).status, 403);
});

test('admin creates a center, validates input, and assigns one operator per center', async () => {
  assert.equal((await call('POST', '/v1/admin/centers', { as: admin, body: centerBody({ latitude: 95 }) })).status, 400);
  assert.equal((await call('POST', '/v1/admin/centers', { as: admin, body: centerBody({ opensAt: '25:00' }) })).status, 400);
  assert.equal((await call('POST', '/v1/admin/centers', { as: admin, body: centerBody({ operatorId: 'never-signed-in' }) })).status, 404);

  const created = await call('POST', '/v1/admin/centers', { as: admin, body: centerBody({ name: 'Kendra A', operatorId: 'op-a', phone: '98220 00000' }) });
  assert.equal(created.status, 201);
  assert.equal(created.json.operatorId, 'op-a');
  assert.equal(created.json.opensAt, '09:00');
  assert.equal(created.json.isOpen, true);
  assert.equal(created.json.status, 'active');

  // op-a already runs a center.
  assert.equal((await call('POST', '/v1/admin/centers', { as: admin, body: centerBody({ operatorId: 'op-a' }) })).status, 409);

  const b = await call('POST', '/v1/admin/centers', { as: admin, body: centerBody({ name: 'Kendra B', village: 'Baramati' }) });
  assert.equal(b.json.operatorId, null);
  const assigned = await call('PUT', `/v1/admin/centers/${b.json.centerId}/operator`, { as: admin, body: { userId: 'op-b' } });
  assert.equal(assigned.json.operatorId, 'op-b');
  assert.equal((await call('PUT', `/v1/admin/centers/${b.json.centerId}/operator`, { as: admin, body: { userId: 'op-a' } })).status, 409);

  assert.equal((await call('GET', '/v1/me', { as: opA })).json.role, 'operator');
  assert.equal((await call('GET', '/v1/me', { as: opA })).json.center.name, 'Kendra A');

  const list = await call('GET', '/v1/admin/centers', { as: admin });
  assert.equal(list.headers.get('x-total-count'), '2');
  assert.equal((await call('GET', '/v1/admin/centers?q=baramati', { as: admin })).json.length, 1);
  assert.equal((await call('GET', '/v1/admin/centers?status=bogus', { as: admin })).status, 400);
});

test('admin can list users, filter unassigned operators, and update or suspend a center', async () => {
  const users = await call('GET', '/v1/admin/users?requestedRole=operator', { as: admin });
  assert.deepEqual(users.json.map((u) => u.userId).sort(), ['op-a', 'op-b']);
  const c = (await call('POST', '/v1/admin/centers', { as: admin, body: centerBody({ name: 'Spare' }) })).json;
  const op3 = await token('op-c', { meta: { role: 'operator' } });
  await call('GET', '/v1/me', { as: op3 });
  const free = await call('GET', '/v1/admin/users?requestedRole=operator&unassigned=true', { as: admin });
  assert.deepEqual(free.json.map((u) => u.userId), ['op-c']);

  const patched = await call('PATCH', `/v1/admin/centers/${c.centerId}`, { as: admin, body: { village: 'Daund', latitude: 18.46 } });
  assert.equal(patched.json.village, 'Daund');
  assert.equal((await call('PATCH', `/v1/admin/centers/${c.centerId}`, { as: admin, body: {} })).status, 400);
  assert.equal((await call('PATCH', '/v1/admin/centers/nope', { as: admin, body: { name: 'x' } })).status, 404);
  assert.equal((await call('PUT', `/v1/admin/centers/${c.centerId}/operator`, { as: admin, body: { userId: null } })).json.operatorId, null);
});

test('operator area needs a center, and a suspended center is locked out', async () => {
  assert.equal((await call('GET', '/v1/operator/inventory/items', { as: farmer })).status, 403);
  const admins = await call('GET', '/v1/operator/center', { as: admin });
  assert.equal(admins.status, 403, 'being an admin does not make you an operator');

  const mine = (await call('GET', '/v1/operator/center', { as: opA })).json;
  assert.equal(mine.name, 'Kendra A');

  await call('PATCH', `/v1/admin/centers/${mine.centerId}`, { as: admin, body: { status: 'suspended' } });
  assert.equal((await call('GET', '/v1/operator/center', { as: opA })).status, 403);
  await call('PATCH', `/v1/admin/centers/${mine.centerId}`, { as: admin, body: { status: 'active' } });
  assert.equal((await call('GET', '/v1/operator/center', { as: opA })).status, 200);
});

test('operators run their own center: open/closed, hours, contact', async () => {
  const off = await call('PATCH', '/v1/operator/center', { as: opA, body: { isOpen: false, opensAt: '08:30', closesAt: '17:00', phone: '99999 11111' } });
  assert.equal(off.json.isOpen, false);
  assert.equal(off.json.opensAt, '08:30');
  assert.equal(off.json.phone, '99999 11111');
  assert.equal((await call('PATCH', '/v1/operator/center', { as: opA, body: { isOpen: 'no' } })).status, 400);
  assert.equal((await call('PATCH', '/v1/operator/center', { as: opA, body: { closesAt: 'late' } })).status, 400);
  // Location and status are the admin's; an operator's attempt is ignored, not applied.
  await call('PATCH', '/v1/operator/center', { as: opA, body: { isOpen: true, latitude: 0, status: 'suspended' } });
  const now = (await call('GET', '/v1/operator/center', { as: opA })).json;
  assert.equal(now.latitude, 18.83);
  assert.equal(now.status, 'active');
});

test('inventory: receive adds up, available = on hand - reserved, capacity and reorder level are enforced', async () => {
  const receive = (as, productId, quantity) => call('POST', '/v1/operator/inventory/receive', { as, body: { productId, quantity } });

  assert.equal((await receive(opA, 'nope', 5)).status, 404);
  assert.equal((await receive(opA, 'p-neemcake', 0)).status, 400);
  const first = await receive(opA, 'p-neemcake', 10);
  assert.equal(first.json.currentStock, 10);
  assert.equal(first.json.lowStockThreshold, 10);
  assert.equal(first.json.isLowStock, true, 'at or below the reorder level');
  assert.equal((await receive(opA, 'p-neemcake', 15)).json.currentStock, 25);
  assert.equal((await call('GET', '/v1/operator/inventory/items', { as: opA })).json[0].isLowStock, false);

  const cap = await call('PATCH', '/v1/operator/inventory/items/p-neemcake', { as: opA, body: { maxCapacity: 30, reorderLevel: 8 } });
  assert.equal(cap.json.maxCapacity, 30);
  assert.equal(cap.json.lowStockThreshold, 8);
  assert.equal((await receive(opA, 'p-neemcake', 6)).status, 409, '25 + 6 exceeds the capacity of 30');
  assert.equal((await receive(opA, 'p-neemcake', 5)).json.currentStock, 30);
  assert.equal((await call('PATCH', '/v1/operator/inventory/items/p-neemcake', { as: opA, body: { maxCapacity: 10 } })).status, 409);
  assert.equal((await call('PATCH', '/v1/operator/inventory/items/p-sprayer', { as: opA, body: { reorderLevel: 1 } })).status, 404);

  // Reserved stock is not available: the database itself refuses reserved > on hand.
  await db.query("UPDATE center_inventory SET reserved = 12 WHERE product_id = 'p-neemcake' AND center_id = (SELECT center_id FROM village_center WHERE operator_id = 'op-a')");
  const item = (await call('GET', '/v1/operator/inventory/items', { as: opA })).json[0];
  assert.equal(item.reserved, 12);
  assert.equal(item.available, 18);
  await assert.rejects(db.query("UPDATE center_inventory SET reserved = 31 WHERE product_id = 'p-neemcake'"), /check/i);

  // Arriving stock clears the same amount from "incoming".
  await db.query("UPDATE center_inventory SET incoming = 20, max_capacity = NULL WHERE product_id = 'p-neemcake'");
  const arrived = await receive(opA, 'p-neemcake', 5);
  assert.equal(arrived.json.incoming, 15);
  assert.ok(arrived.json.lastRestockedAt);

  // Concurrent receipts add up exactly.
  const before = arrived.json.currentStock;
  await Promise.all(Array.from({ length: 8 }, () => receive(opA, 'p-neemcake', 2)));
  assert.equal((await call('GET', '/v1/operator/inventory/items', { as: opA })).json[0].currentStock, before + 16);
});

test('operators never see another center\'s stock, orders, or restock requests', async () => {
  // op-b has stocked nothing.
  assert.deepEqual((await call('GET', '/v1/operator/inventory/items', { as: opB })).json, []);
  await call('POST', '/v1/operator/inventory/restock-requests', { as: opA, body: { productId: 'p-neemcake', quantity: 5 } });
  assert.equal((await call('GET', '/v1/operator/inventory/restock-requests', { as: opA })).json.length, 1);
  assert.deepEqual((await call('GET', '/v1/operator/inventory/restock-requests', { as: opB })).json, []);

  const centerA = (await call('GET', '/v1/operator/center', { as: opA })).json.centerId;
  const placed = await call('POST', '/v1/orders', { as: farmer, body: { centerId: centerA, items: [{ productId: 'p-neemcake', quantity: 1 }] } });
  assert.equal(placed.status, 201);
  assert.equal(placed.json.centerId, centerA);
  const id = placed.json.id;

  assert.equal((await call('GET', '/v1/operator/orders', { as: opA })).json.length, 1);
  assert.deepEqual((await call('GET', '/v1/operator/orders', { as: opB })).json, []);
  for (const [method, path, body] of [
    ['GET', `/v1/operator/orders/${id}`],
    ['POST', `/v1/operator/orders/${id}/ready`],
    ['POST', `/v1/operator/orders/${id}/verify-otp`, { otp: placed.json.pickupOtp }],
    ['POST', `/v1/operator/orders/${id}/cancel`],
  ]) {
    assert.equal((await call(method, path, { as: opB, body })).status, 404, `${method} ${path} from the wrong center`);
  }
  assert.equal((await call('POST', `/v1/operator/orders/${id}/ready`, { as: opA })).json.status, 'readyForPickup');

  // Earnings only count the operator's own completed orders.
  await call('POST', `/v1/operator/orders/${id}/verify-otp`, { as: opA, body: { otp: placed.json.pickupOtp } });
  assert.ok((await call('GET', '/v1/operator/earnings/summary', { as: opA })).json.monthSales > 0);
  assert.equal((await call('GET', '/v1/operator/earnings/summary', { as: opB })).json.monthSales, 0);
});

test('a farmer order can only name a real, active center', async () => {
  const items = [{ productId: 'p-neemcake', quantity: 1 }];
  assert.equal((await call('POST', '/v1/orders', { as: farmer, body: { centerId: 'nope', items } })).status, 404);
  const centerA = (await call('GET', '/v1/operator/center', { as: opA })).json.centerId;
  await call('PATCH', `/v1/admin/centers/${centerA}`, { as: admin, body: { status: 'suspended' } });
  assert.equal((await call('POST', '/v1/orders', { as: farmer, body: { centerId: centerA, items } })).status, 404);
  await call('PATCH', `/v1/admin/centers/${centerA}`, { as: admin, body: { status: 'active' } });
  // With neither a center nor a location there is nothing to assign it to.
  const loose = await call('POST', '/v1/orders', { as: farmer, body: { items } });
  assert.equal(loose.status, 400);
  assert.match(loose.json.error, /location/i);
});

test('migration 003 keeps real farmer orders and drops only the demo data', async () => {
  const fs = require('fs');
  const path = require('path');
  const { createDb } = require('../src/db/database');
  const { ensureDatabaseExists } = require('../src/db/bootstrap');
  const url = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/khaad_test';
  await ensureDatabaseExists(url);
  const legacy = createDb({ url, schema: 't_centers_migration' });
  await legacy.dropSchema();
  await legacy.query('CREATE SCHEMA t_centers_migration');
  try {
    // Bring the schema to the state just before 003, with old-style data in it.
    const dir = path.join(__dirname, '..', 'migrations');
    await legacy.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql') && n < '003').sort()) {
      await legacy.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await legacy.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    }
    await legacy.query("INSERT INTO inventory_items (id, name, unit, unit_price, current_stock, low_stock_threshold) VALUES ('inv-x','X','bag',1,1,1)");
    await legacy.query("INSERT INTO farmers (id, name, village, phone, active_crop, last_visit_date) VALUES ('f1','F','V','1','Wheat', now())");
    await legacy.query("INSERT INTO orders (id, customer_name, type, status, owner_id) VALUES ('order-1','Demo','appOrder','pending',NULL), ('order-real','Real','appOrder','pending','user-9')");
    await legacy.query("INSERT INTO order_items (order_id, position, product_name, quantity, unit_price) VALUES ('order-1',0,'a',1,1), ('order-real',0,'b',1,1)");

    await legacy.migrate(); // applies 003 on top

    assert.deepEqual((await legacy.rows('SELECT id, center_id FROM orders')).map((o) => [o.id, o.center_id]), [['order-real', null]]);
    assert.equal((await legacy.one('SELECT count(*)::int AS n FROM order_items')).n, 1);
    assert.equal((await legacy.one('SELECT count(*)::int AS n FROM farmers')).n, 0);
    assert.equal((await legacy.one('SELECT count(*)::int AS n FROM village_center')).n, 0);
  } finally {
    await legacy.dropSchema();
    await legacy.close();
  }
});
