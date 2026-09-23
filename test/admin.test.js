process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = require('jose');

// The admin panel's API, with real signed tokens: categories, suspension,
// oversight, restock approval and the audit log.

const SUPABASE = 'https://test-project.supabase.co';
const ADMIN_EMAIL = 'boss@example.com';
const BASE = { latitude: 18.5, longitude: 74.0 };

let server;
let base;
let db;
let key;
const T = {}; // tokens by name
const centers = {};

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
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(as ? { authorization: `Bearer ${as}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};
const admin = (method, path, body) => call(method, `/v1/admin${path}`, { as: T.admin, body });

const signUp = async (name, meta) => {
  T[name] = await token(name, { meta });
  await call('GET', '/v1/me', { as: T[name] });
};
const makeCenter = async (key2, dLat, operator, extra = {}) => {
  const res = await admin('POST', '/centers', {
    name: `Center ${key2}`, village: key2, district: extra.district || 'Pune', latitude: BASE.latitude + dLat, longitude: BASE.longitude,
    operatorId: operator, opensAt: '00:00', closesAt: '23:59', ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  centers[key2] = res.json;
  return res.json;
};

test.before(async () => {
  const pair = await generateKeyPair('ES256');
  key = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k', alg: 'ES256', use: 'sig' };
  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  db = await openTestDb('t_admin');
  const app = createApp(db, { auth: { supabaseUrl: SUPABASE, jwks: createLocalJWKSet({ keys: [jwk] }) }, superAdminEmails: [ADMIN_EMAIL] });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  T.admin = await token('admin-1', { email: ADMIN_EMAIL });
  await call('GET', '/v1/me', { as: T.admin });
  await signUp('farm-a', { role: 'farmer', full_name: 'Asha Farmer' });
  await signUp('farm-b', { role: 'farmer', full_name: 'Bhau Farmer' });
  await signUp('op-active', { role: 'operator', full_name: 'Active Operator' });
  await signUp('op-pending', { role: 'operator', full_name: 'Pending Operator' });
  await signUp('op-susp-center', { role: 'operator', full_name: 'Suspended Center Operator' });
  await makeCenter('active', 0.02, 'op-active');
  await makeCenter('suspcenter', 0.04, 'op-susp-center', { district: 'Nashik' });
  await admin('PATCH', `/centers/${centers.suspcenter.centerId}`, { status: 'suspended' });
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

test('every admin endpoint is closed to farmers and operators', async () => {
  const paths = ['/overview', '/users', '/users/summary', '/users/farm-a', '/centers', '/orders', '/restock-requests', '/audit'];
  for (const who of ['farm-a', 'op-active']) {
    for (const p of paths) assert.equal((await call('GET', `/v1/admin${p}`, { as: T[who] })).status, 403, `${who} ${p}`);
    assert.equal((await call('PATCH', '/v1/admin/users/farm-b', { as: T[who], body: { status: 'suspended' } })).status, 403);
  }
  assert.equal((await call('GET', '/v1/admin/overview')).status, 401);
});

test('people are categorised: operators active / suspended / unassigned, farmers active / suspended', async () => {
  const summary = (await admin('GET', '/users/summary')).json;
  assert.deepEqual(summary, {
    operators: { active: 1, suspended: 1, unassigned: 1, total: 3 },
    farmers: { active: 2, suspended: 0, total: 2 },
  });

  const list = async (qs) => (await admin('GET', `/users${qs}`)).json;
  const ids = (rows) => rows.map((u) => u.userId).sort();
  assert.deepEqual(ids(await list('?role=operator')), ['op-active', 'op-pending', 'op-susp-center']);
  assert.deepEqual(ids(await list('?role=operator&segment=active')), ['op-active']);
  assert.deepEqual(ids(await list('?role=operator&segment=unassigned')), ['op-pending']);
  assert.deepEqual(ids(await list('?role=operator&segment=suspended')), ['op-susp-center'], 'a suspended center suspends its operator\'s standing');
  assert.deepEqual(ids(await list('?role=farmer')), ['farm-a', 'farm-b']);
  assert.deepEqual(ids(await list('?q=asha')), ['farm-a']);
  assert.equal((await admin('GET', '/users?role=admin')).status, 400);
  assert.equal((await admin('GET', '/users?segment=bogus')).status, 400);

  const everyone = await admin('GET', '/users');
  assert.equal(everyone.headers.get('x-total-count'), '5');
  assert.ok(!ids(everyone.json).includes('admin-1'), 'administrators are not listed among the people they manage');

  const active = (await list('?role=operator&segment=active'))[0];
  assert.equal(active.centerName, 'Center active');
  assert.equal(active.role, 'operator');
});

test('overview counts what needs attention', async () => {
  const o = (await admin('GET', '/overview')).json;
  assert.deepEqual(o.people, (await admin('GET', '/users/summary')).json);
  assert.deepEqual(o.centers, { active: 1, suspended: 1, withoutOperator: 0, total: 2 });
  assert.equal(o.orders.pending, 0);
  assert.equal(o.restockRequests.pending, 0);
  assert.equal(o.lowStockItems, 0);
});

test('suspending a person locks them out at once, tells them, is reversible, and is audited', async () => {
  assert.equal((await call('GET', '/v1/products', { as: T['farm-b'] })).status, 200);
  const res = await admin('PATCH', '/users/farm-b', { status: 'suspended', reason: 'Spam posts' });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'suspended');
  assert.equal(res.json.segment, 'suspended');

  const blocked = await call('GET', '/v1/products', { as: T['farm-b'] });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'account_suspended');
  assert.equal((await call('POST', '/v1/community/posts', { as: T['farm-b'], body: { title: 'hello there', content: 'some words', problemTypeTag: 'general' } })).status, 403);
  // /me stays open so the app can say why.
  assert.equal((await call('GET', '/v1/me', { as: T['farm-b'] })).json.status, 'suspended');
  // ... and other people are unaffected.
  assert.equal((await call('GET', '/v1/products', { as: T['farm-a'] })).status, 200);

  assert.equal((await admin('GET', '/users/summary')).json.farmers.suspended, 1);
  assert.equal((await admin('GET', '/users?role=farmer&segment=suspended')).json[0].userId, 'farm-b');

  await admin('PATCH', '/users/farm-b', { status: 'active' });
  assert.equal((await call('GET', '/v1/products', { as: T['farm-b'] })).status, 200);
});

test('admin actions are guarded: not yourself, not administrators, not unknown people, valid status only', async () => {
  assert.equal((await admin('PATCH', '/users/admin-1', { status: 'suspended' })).status, 400);
  assert.equal((await admin('PATCH', '/users/nobody', { status: 'suspended' })).status, 404);
  assert.equal((await admin('PATCH', '/users/farm-a', { status: 'banished' })).status, 400);
  assert.equal((await admin('PATCH', '/users/farm-a', {})).status, 400);
  // Even if an administrator somehow had a suspended row, the API would not lock them out.
  await db.query("UPDATE app_user SET status = 'suspended' WHERE user_id = 'admin-1'");
  assert.equal((await admin('GET', '/overview')).status, 200);
  await db.query("UPDATE app_user SET status = 'active' WHERE user_id = 'admin-1'");
});

test('a suspended operator is locked out and their center stops being offered to farmers', async () => {
  const nearby = async () => (await call('POST', '/v1/centers/nearby', { as: T['farm-a'], body: BASE })).json.centers.map((c) => c.center.village);
  assert.deepEqual(await nearby(), ['active']);
  assert.equal((await call('GET', '/v1/operator/center', { as: T['op-active'] })).status, 200);

  await admin('PATCH', '/users/op-active', { status: 'suspended' });
  assert.equal((await call('GET', '/v1/operator/center', { as: T['op-active'] })).status, 403);
  assert.deepEqual(await nearby(), [], 'a center whose operator is suspended cannot serve anyone');
  await call('POST', '/v1/operator/inventory/receive', { as: T['op-active'], body: { productId: 'p-neemcake', quantity: 5 } });
  assert.equal((await call('POST', '/v1/orders', { as: T['farm-a'], body: { centerId: centers.active.centerId, items: [{ productId: 'p-neemcake', quantity: 1 }] } })).status, 404);

  await admin('PATCH', '/users/op-active', { status: 'active' });
  assert.deepEqual(await nearby(), ['active']);
});

test('centers list shows the operator and how the center is doing, with filters and a stock view', async () => {
  await call('POST', '/v1/operator/inventory/receive', { as: T['op-active'], body: { productId: 'p-neemcake', quantity: 5 } });
  await call('PATCH', '/v1/operator/inventory/items/p-neemcake', { as: T['op-active'], body: { reorderLevel: 10 } });
  await call('POST', '/v1/operator/inventory/receive', { as: T['op-active'], body: { productId: 'p-sprayer', quantity: 50 } });
  await call('POST', '/v1/orders', { as: T['farm-a'], body: { centerId: centers.active.centerId, items: [{ productId: 'p-sprayer', quantity: 2 }] } });

  const row = (await admin('GET', '/centers')).json.find((c) => c.village === 'active');
  assert.equal(row.operatorEmail, 'op-active@example.com');
  assert.equal(row.operatorUserName, 'Active Operator');
  assert.equal(row.operatorStatus, 'active');
  assert.equal(row.productsStocked, 2);
  assert.equal(row.lowStockCount, 1, 'neem cake is at or under its reorder level');
  assert.equal(row.pendingOrders, 1);
  assert.equal((await admin('GET', `/centers/${centers.active.centerId}`)).json.pendingOrders, 1);

  assert.deepEqual((await admin('GET', '/centers?status=suspended')).json.map((c) => c.village), ['suspcenter']);
  assert.deepEqual((await admin('GET', '/centers?district=nashik')).json.map((c) => c.village), ['suspcenter']);
  await admin('POST', '/centers', { name: 'Orphan', village: 'Orphanville', latitude: 18, longitude: 74 });
  assert.deepEqual((await admin('GET', '/centers?hasOperator=false')).json.map((c) => c.village), ['Orphanville']);
  assert.equal((await admin('GET', '/centers/nope')).status, 404);

  const stock = await admin('GET', `/centers/${centers.active.centerId}/inventory`);
  assert.equal(stock.json.length, 2);
  assert.equal(stock.json.find((i) => i.id === 'p-sprayer').reserved, 2);
  assert.equal((await admin('GET', '/centers/nope/inventory')).status, 404);
});

test('a person\'s detail shows their activity', async () => {
  const detail = (await admin('GET', '/users/farm-a')).json;
  assert.equal(detail.name, 'Asha Farmer');
  assert.equal(detail.activity.orders.pending, 1);
  assert.equal(detail.activity.scans, 0);
  assert.ok('homeCenterId' in detail.profile);
  const op = (await admin('GET', '/users/op-active')).json;
  assert.equal(op.centerName, 'Center active');
  assert.equal((await admin('GET', '/users/nobody')).status, 404);
  assert.equal((await admin('GET', '/users/admin-1')).status, 404, 'administrators are not people to manage');
});

test('orders across every center, filterable, never exposing pickup codes', async () => {
  const all = await admin('GET', '/orders');
  assert.ok(all.json.length >= 1);
  const o = all.json.find((x) => x.centerId === centers.active.centerId);
  assert.equal(o.centerName, 'Center active');
  assert.equal(o.pickupOtp, null);
  assert.ok(o.items.length >= 1);
  assert.equal(all.headers.get('x-total-count'), String(all.json.length));
  assert.equal((await admin('GET', `/orders?centerId=${centers.active.centerId}&status=pending`)).json.length, 1);
  assert.equal((await admin('GET', `/orders?centerId=${centers.suspcenter.centerId}`)).json.length, 0);
  assert.equal((await admin('GET', '/orders?type=walkIn')).json.length, 0);
  assert.equal((await admin('GET', '/orders?status=bogus')).status, 400);
});

test('restock: the operator asks, the admin approves (which adds to "incoming"), then it is delivered', async () => {
  const asked = await call('POST', '/v1/operator/inventory/restock-requests', { as: T['op-active'], body: { itemId: 'p-vermicompost', quantity: 30 } });
  assert.equal(asked.status, 201);
  const id = asked.json.id;
  assert.equal((await admin('GET', '/restock-requests?status=pending')).json.find((r) => r.id === id).centerName, 'Center active');
  assert.equal((await admin('GET', '/overview')).json.restockRequests.pending, 1);

  assert.equal((await admin('PATCH', `/restock-requests/${id}`, { status: 'fulfilled' })).status, 409, 'cannot skip approval');
  assert.equal((await admin('PATCH', `/restock-requests/${id}`, { status: 'pending' })).status, 400);
  assert.equal((await admin('PATCH', '/restock-requests/nope', { status: 'approved' })).status, 404);

  assert.equal((await admin('PATCH', `/restock-requests/${id}`, { status: 'approved' })).json.status, 'approved');
  const incoming = async () => (await call('GET', '/v1/operator/inventory/items', { as: T['op-active'] })).json.find((i) => i.id === 'p-vermicompost');
  assert.equal((await incoming()).incoming, 30);
  assert.equal((await incoming()).currentStock, 0);
  assert.equal((await admin('PATCH', `/restock-requests/${id}`, { status: 'approved' })).status, 409, 'not twice: that would add it twice');
  assert.equal((await incoming()).incoming, 30);

  const opNote = (await call('GET', '/v1/farmer/notifications', { as: T['op-active'] })).json;
  assert.ok(opNote.some((n) => n.title === 'Restock approved' && n.refId === id));

  assert.equal((await admin('PATCH', `/restock-requests/${id}`, { status: 'fulfilled' })).json.status, 'fulfilled');
  assert.equal((await admin('GET', '/restock-requests?status=fulfilled')).json.length, 1);
  assert.equal((await admin('PATCH', `/restock-requests/${id}`, { status: 'fulfilled' })).status, 409);

  // Receiving the goods turns "incoming" into stock.
  await call('POST', '/v1/operator/inventory/receive', { as: T['op-active'], body: { productId: 'p-vermicompost', quantity: 30 } });
  const after = await incoming();
  assert.equal(after.incoming, 0);
  assert.equal(after.currentStock, 30);
});

test('every change is in the audit log, with who did it, and the log is filterable', async () => {
  const log = (await admin('GET', '/audit')).json;
  assert.ok(log.every((e) => e.adminEmail === ADMIN_EMAIL && e.adminId === 'admin-1'));
  const actions = log.map((e) => e.action);
  for (const a of ['center.create', 'center.suspend', 'user.suspend', 'user.reactivate', 'restock.approved', 'restock.fulfilled']) {
    assert.ok(actions.includes(a), `missing ${a}`);
  }
  const suspend = log.find((e) => e.action === 'user.suspend' && e.targetId === 'farm-b');
  assert.equal(suspend.details.reason, 'Spam posts');
  assert.equal(suspend.details.role, 'farmer');
  assert.equal(suspend.targetType, 'user');

  const forUser = (await admin('GET', '/audit?targetType=user&targetId=farm-b')).json;
  assert.deepEqual(forUser.map((e) => e.action).sort(), ['user.reactivate', 'user.suspend']);
  assert.ok((await admin('GET', '/audit')).headers.get('x-total-count') >= 8);

  // Failed actions leave no trace: the audit entry rolls back with the change.
  const before = (await admin('GET', '/audit')).headers.get('x-total-count');
  assert.equal((await admin('PATCH', `/centers/${centers.active.centerId}`, { latitude: 500 })).status, 400);
  assert.equal((await admin('POST', '/centers', { name: 'x', village: 'y', latitude: 1, longitude: 1, operatorId: 'op-active' })).status, 409);
  assert.equal((await admin('GET', '/audit')).headers.get('x-total-count'), before);
});

test('assigning an unassigned operator moves them out of "unassigned" and is audited', async () => {
  const c = (await admin('POST', '/centers', { name: 'For pending', village: 'Pendingpur', latitude: 18.9, longitude: 74.2 })).json;
  const res = await admin('PUT', `/centers/${c.centerId}/operator`, { userId: 'op-pending' });
  assert.equal(res.json.operatorId, 'op-pending');
  assert.equal((await admin('GET', '/users/summary')).json.operators.unassigned, 0);
  assert.equal((await call('GET', '/v1/me', { as: T['op-pending'] })).json.role, 'operator');
  assert.ok((await admin('GET', `/audit?targetId=${c.centerId}`)).json.some((e) => e.action === 'center.assignOperator'));
  // Unassigning puts them back.
  await admin('PUT', `/centers/${c.centerId}/operator`, { userId: null });
  assert.equal((await admin('GET', '/users/summary')).json.operators.unassigned, 1);
});
