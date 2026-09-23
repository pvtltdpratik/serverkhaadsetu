process.env.NODE_ENV = 'test';
// These tests cover the anonymous X-Device-Id mode; auth has its own file.
process.env.SUPABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');

let server;
let base;
let db;
let centerId;

test.before(async () => {
  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  db = await openTestDb('t_api');
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  // No demo centers are seeded: create one and make device 'op-1' its operator.
  await fetch(`${base}/v1/me`, { headers: { 'x-device-id': 'op-1' } });
  const created = await fetch(`${base}/v1/admin/centers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-id': 'admin-dev' },
    body: JSON.stringify({ name: 'Test Kendra', village: 'Shirur', latitude: 18.83, longitude: 74.38, operatorId: 'op-1' }),
  });
  centerId = (await created.json()).centerId;
  for (const productId of ['p-vermicompost', 'p-neemcake', 'p-sprayer']) {
    await fetch(`${base}/v1/operator/inventory/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': 'op-1' },
      body: JSON.stringify({ productId, quantity: 100 }),
    });
  }
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

const call = async (method, path, { body, device, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(device ? { 'x-device-id': device } : path.startsWith('/v1/operator') ? { 'x-device-id': 'op-1' } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};

const { testImage } = require('./helpers');
const photo = () => testImage();

test('health and 404', async () => {
  assert.equal((await call('GET', '/health')).json.status, 'ok');
  assert.equal((await call('GET', '/v1/nope')).status, 404);
});

test('soil: analyze -> history -> scan by id, matching the Flutter contract', async () => {
  const form = new FormData();
  form.append('metadata_json', JSON.stringify({ device_id: 'dev-soil', crop_type: 'tomato' }));
  // The Flutter client uploads as application/octet-stream.
  form.append('image', new Blob([await photo()], { type: 'application/octet-stream' }), 'scan.jpg');
  const analyzed = await call('POST', '/v1/analyze', { body: form });
  assert.equal(analyzed.status, 200);

  const scan = analyzed.json;
  for (const key of ['id', 'created_at', 'health_score', 'soil_moisture', 'nutrient_n', 'nutrient_p', 'nutrient_k', 'disease', 'disease_confidence']) {
    assert.ok(key in scan, `missing ${key}`);
  }
  // Explicit UTC, close to now.
  assert.ok(scan.created_at.endsWith('Z'));
  assert.ok(Math.abs(Date.now() - Date.parse(scan.created_at)) < 60000);
  assert.match(scan.id, /^[0-9a-f-]{36}$/);
  assert.ok(scan.recommendations.length > 0);
  assert.equal(scan.metadata.crop_type, 'tomato');
  assert.ok(scan.health_score >= 0 && scan.health_score <= 100);

  const history = await call('GET', '/v1/history?device_id=dev-soil');
  assert.equal(history.json.length, 1);
  assert.equal((await call('GET', `/v1/scan/${scan.id}`, { device: 'dev-soil' })).json.id, scan.id);
  assert.equal((await call('GET', `/v1/scan/${scan.id}`, { device: 'someone-else' })).status, 404);
  assert.deepEqual((await call('GET', '/v1/history?device_id=other')).json, []);
  assert.equal((await call('GET', '/v1/history')).status, 400);

  const rec = await call('GET', '/v1/farmer/recommendation', { device: 'dev-soil' });
  assert.ok(['nutrient', 'water', 'pest', 'harvest'].includes(rec.json.category));
});

const scanForm = async (fields = { device_id: 'dev-many' }, { asMetadata = true } = {}) => {
  const form = new FormData();
  if (asMetadata) form.append('metadata_json', JSON.stringify(fields));
  else for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('image', new Blob([await photo()]), 'scan.jpg');
  return form;
};

test('soil: keeps only the 5 newest scans', async () => {
  for (let i = 0; i < 7; i++) {
    assert.equal((await call('POST', '/v1/analyze', { body: await scanForm() })).status, 200);
  }
  assert.equal((await call('GET', '/v1/history?device_id=dev-many')).json.length, 5);
});

test('soil: plant type is optional and also accepted as a plain form field', async () => {
  const bare = await call('POST', '/v1/analyze', { body: await scanForm({ device_id: 'dev-bare' }) });
  assert.equal(bare.status, 200);
  assert.ok(!('crop_type' in bare.json.metadata));

  const plain = await call('POST', '/v1/analyze', { body: await scanForm({ device_id: 'dev-plain', plant_type: 'chilli' }, { asMetadata: false }) });
  assert.equal(plain.status, 200);
  assert.equal(plain.json.metadata.crop_type, 'chilli');
});

test('soil: bad requests are rejected and never stored', async () => {
  const before = (await call('GET', '/v1/history?device_id=dev-fail')).json.length;

  const noImage = new FormData();
  noImage.append('metadata_json', JSON.stringify({ device_id: 'dev-fail' }));
  assert.equal((await call('POST', '/v1/analyze', { body: noImage })).status, 400);

  assert.equal((await call('POST', '/v1/analyze', { body: await scanForm({}) })).status, 400);

  // Not an image at all (unknown magic bytes), whatever the client claims.
  const text = new FormData();
  text.append('metadata_json', JSON.stringify({ device_id: 'dev-fail' }));
  text.append('image', new Blob(['hello, not an image'], { type: 'image/jpeg' }), 'scan.jpg');
  assert.equal((await call('POST', '/v1/analyze', { body: text })).status, 400);

  // Looks like a JPEG but is truncated garbage: cannot be decoded.
  const corrupt = new FormData();
  corrupt.append('metadata_json', JSON.stringify({ device_id: 'dev-fail' }));
  corrupt.append('image', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], { type: 'image/jpeg' }), 'scan.jpg');
  const res = await call('POST', '/v1/analyze', { body: corrupt });
  assert.equal(res.status, 422);
  assert.match(res.json.error, /not a valid image/);

  assert.equal((await call('GET', '/v1/history?device_id=dev-fail')).json.length, before);
});

test('soil: the heuristic tells healthy foliage from diseased-looking leaves', async () => {
  const scanColor = async (color, format) => {
    const form = new FormData();
    form.append('metadata_json', JSON.stringify({ device_id: 'dev-color' }));
    form.append('image', new Blob([await testImage(color, format)]), 'scan.img');
    const res = await call('POST', '/v1/analyze', { body: form });
    assert.equal(res.status, 200, format);
    return res.json;
  };

  const green = await scanColor([60, 180, 60], 'png');
  assert.equal(green.disease, 'No disease detected');
  assert.ok(green.nutrient_n > green.nutrient_p);

  // A uniform brown patch: every pixel counts as an anomaly.
  const brown = await scanColor([140, 90, 40], 'webp');
  assert.equal(brown.disease, 'Fungal infection suspected');
  assert.ok(brown.recommendations.some((r) => /fungicide/i.test(r)));

  // Nearly black: also anomalous, with every nutrient reading at the floor.
  const dark = await scanColor([10, 10, 10], 'jpeg');
  assert.equal(dark.disease, 'Fungal infection suspected');
  assert.equal(dark.nutrient_n, 0);
  assert.ok(dark.recommendations.some((r) => /nitrogen/i.test(r)));
});

test('recommendation nudges a first scan when there is none', async () => {
  const rec = await call('GET', '/v1/farmer/recommendation', { device: 'brand-new' });
  assert.equal(rec.json.actionLabel, 'Scan soil');
});

test('weather validates coordinates', async () => {
  assert.equal((await call('GET', '/v1/weather?lat=999&lon=10')).status, 400);
  assert.equal((await call('GET', '/v1/weather')).status, 400);
});

test('farmer profile defaults and updates', async () => {
  const before = await call('GET', '/v1/farmer/profile', { device: 'dev-p' });
  assert.equal(before.json.landHoldingHectares, 0);
  const put = await call('PUT', '/v1/farmer/profile', {
    device: 'dev-p',
    // unreadNotificationCount is derived from real notifications, so a client can't set it.
    body: { name: 'Pratik Kolhe', village: 'Shirur, Pune', landHoldingHectares: 1.5, unreadNotificationCount: 3 },
  });
  assert.equal(put.json.name, 'Pratik Kolhe');
  assert.equal(put.json.unreadNotificationCount, 0);
  assert.equal((await call('GET', '/v1/farmer/profile', { device: 'dev-p' })).json.landHoldingHectares, 1.5);
  assert.equal((await call('PUT', '/v1/farmer/profile', { device: 'dev-p', body: { landHoldingHectares: -1 } })).status, 400);
});

test('marketplace: catalog, filters, reviews', async () => {
  const all = await call('GET', '/v1/products');
  assert.equal(all.json.length, 5);
  assert.equal(all.headers.get('x-total-count'), '5');
  assert.equal((await call('GET', '/v1/products?category=organic')).json.length, 2);
  assert.equal((await call('GET', '/v1/products?category=bogus')).status, 400);
  assert.equal((await call('GET', '/v1/products?q=neem')).json.length, 2);
  const product = (await call('GET', '/v1/products/p-neemcake')).json;
  assert.equal(product.npkPercentages.nitrogen, 2);
  assert.equal((await call('GET', '/v1/products/nope')).status, 404);

  const reviews = await call('GET', '/v1/products/p-neemcake/reviews');
  assert.equal(reviews.json.length, 3);
  const posted = await call('POST', '/v1/products/p-neemcake/reviews', {
    body: { authorName: 'Test', rating: 5, comment: 'Great stuff' },
  });
  assert.equal(posted.status, 201);
  assert.equal((await call('GET', '/v1/products/p-neemcake')).json.reviewCount, product.reviewCount + 1);
  assert.equal((await call('POST', '/v1/products/p-neemcake/reviews', { body: { authorName: 'T', rating: 9, comment: 'x' } })).status, 400);
});

// The community feature (posts/comments/likes/agronomist verification) has
// its own suite: test/community.test.js.

test('schemes: directory, apply, idempotence, eligibility', async () => {
  const schemes = await call('GET', '/v1/schemes');
  assert.equal(schemes.json.length, 5);
  assert.equal((await call('GET', '/v1/schemes/scheme-pkvy')).json.maxLandHoldingHectares, 2);

  const before = await call('GET', '/v1/schemes/scheme-kcc/application', { device: 'dev-s' });
  assert.deepEqual(before.json, { schemeId: 'scheme-kcc', status: 'notApplied', appliedDate: null });
  const applied = await call('POST', '/v1/schemes/scheme-kcc/apply', { device: 'dev-s' });
  assert.equal(applied.json.status, 'submitted');
  const again = await call('POST', '/v1/schemes/scheme-kcc/apply', { device: 'dev-s' });
  assert.equal(again.json.appliedDate, applied.json.appliedDate);
  assert.equal((await call('GET', '/v1/schemes/applications', { device: 'dev-s' })).json.length, 1);
  assert.equal((await call('GET', '/v1/schemes/scheme-kcc/application', { device: 'other' })).json.status, 'notApplied');

  await call('PUT', '/v1/farmer/profile', { device: 'big-farm', body: { landHoldingHectares: 5 } });
  assert.equal((await call('POST', '/v1/schemes/scheme-pkvy/apply', { device: 'big-farm' })).status, 403);
  assert.equal((await call('POST', '/v1/schemes/nope/apply', { device: 'dev-s' })).status, 404);
});

test('orders: farmer places, operator fulfils with OTP', async () => {
  const placed = await call('POST', '/v1/orders', {
    device: 'dev-o',
    body: { customerName: 'Tester', centerId, items: [{ productId: 'p-vermicompost', quantity: 2, unitPrice: 1 }] },
  });
  assert.equal(placed.status, 201);
  assert.equal(placed.json.totalAmount, 900); // price comes from the catalog, not the client
  assert.match(placed.json.pickupOtp, /^\d{4}$/);
  const id = placed.json.id;
  const otp = placed.json.pickupOtp;

  assert.equal((await call('GET', `/v1/orders/${id}`, { device: 'intruder' })).status, 404);
  assert.equal((await call('GET', '/v1/orders', { device: 'dev-o' })).json.length, 1);

  const op = await call('GET', `/v1/operator/orders/${id}`);
  assert.equal(op.json.pickupOtp, null);
  assert.equal(op.json.type, 'appOrder');

  assert.equal((await call('POST', `/v1/operator/orders/${id}/verify-otp`, { body: { otp } })).status, 409);
  assert.equal((await call('POST', `/v1/operator/orders/${id}/ready`)).json.status, 'readyForPickup');
  const wrong = await call('POST', `/v1/operator/orders/${id}/verify-otp`, { body: { otp: otp === '0000' ? '1111' : '0000' } });
  assert.equal(wrong.status, 400);
  const done = await call('POST', `/v1/operator/orders/${id}/verify-otp`, { body: { otp } });
  assert.equal(done.json.status, 'completed');
  assert.equal((await call('GET', `/v1/orders/${id}`, { device: 'dev-o' })).json.pickupOtp, null);
  assert.equal((await call('POST', `/v1/orders/${id}/cancel`, { device: 'dev-o' })).status, 409);

  assert.equal((await call('POST', '/v1/orders', { device: 'dev-o', body: { items: [] } })).status, 400);
  assert.equal((await call('POST', '/v1/orders', { device: 'dev-o', body: { items: [{ productId: 'zzz', quantity: 1 }] } })).status, 404);
});

test('operator: orders, walk-in sale, inventory, restock, earnings (scoped to my center)', async () => {
  // Nothing is seeded for a new center.
  assert.deepEqual((await call('GET', '/v1/operator/orders?type=walkIn')).json, []);
  assert.deepEqual((await call('GET', '/v1/operator/farmers')).json, []);
  assert.equal((await call('GET', '/v1/operator/farmers/nope')).status, 404);

  const orders = await call('GET', '/v1/operator/orders');
  assert.ok(orders.json.every((o) => o.pickupOtp === null && o.centerId === centerId));
  assert.ok(orders.json.every((o) => !('deviceId' in o)));
  assert.equal((await call('GET', '/v1/operator/orders?status=pending')).json.every((o) => o.status === 'pending'), true);
  assert.equal((await call('GET', '/v1/operator/orders?status=bogus')).status, 400);

  const walkIn = await call('POST', '/v1/operator/orders/walk-in', {
    body: { customerName: 'Sita', items: [{ productName: 'Neem Cake', quantity: 2, unitPrice: 600 }] },
  });
  assert.equal(walkIn.status, 201);
  assert.equal(walkIn.json.status, 'completed');
  assert.equal(walkIn.json.totalAmount, 1200);
  assert.equal(walkIn.json.centerId, centerId);
  assert.equal((await call('POST', '/v1/operator/orders/walk-in', { body: { items: [{ productName: 'x', quantity: 0, unitPrice: 1 }] } })).status, 400);

  const before = (await call('GET', '/v1/operator/inventory/items')).json.find((i) => i.id === 'p-neemcake');
  const received = await call('POST', '/v1/operator/inventory/receive', { body: { productId: 'p-neemcake', quantity: 5 } });
  assert.equal(received.status, 201);
  assert.equal(received.json.currentStock, before.currentStock + 5);
  assert.equal(received.json.available, before.available + 5);
  const items = await call('GET', '/v1/operator/inventory/items');
  assert.equal(items.json.length, 3, 'only what this center stocks');

  const restock = await call('POST', '/v1/operator/inventory/restock-requests', { body: { itemId: 'p-neemcake', quantity: 20 } });
  assert.equal(restock.status, 201);
  assert.equal(restock.json.status, 'pending');
  assert.equal(restock.json.itemName, 'Neem Cake');
  assert.equal((await call('GET', '/v1/operator/inventory/restock-requests')).json[0].id, restock.json.id);
  assert.equal((await call('POST', '/v1/operator/inventory/restock-requests', { body: { itemId: 'nope', quantity: 1 } })).status, 404);

  assert.equal((await call('GET', '/v1/operator/earnings/commission-rate')).json.commissionRatePercent, 5);
  const summary = (await call('GET', '/v1/operator/earnings/summary')).json;
  assert.ok(summary.monthSales >= 1200);
  assert.equal(summary.monthCommission, (summary.monthSales * 5) / 100);
});

test('malformed JSON is a 400, not a 500', async () => {
  const res = await fetch(`${base}/v1/community/posts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(res.status, 400);
});

test('notifications: created by real events, listed, marked read, drive the badge count', async () => {
  const dev = 'dev-notif';
  const count = async () => (await call('GET', '/v1/farmer/profile', { device: dev })).json.unreadNotificationCount;
  assert.equal(await count(), 0);
  assert.deepEqual((await call('GET', '/v1/farmer/notifications', { device: dev })).json, []);

  // 1. a scan
  const scanRes = await call('POST', '/v1/analyze', { body: await scanForm({ device_id: dev }) });
  assert.equal(await count(), 1);

  // 2. a scheme application (a repeat apply must not notify again)
  await call('POST', '/v1/schemes/scheme-kcc/apply', { device: dev });
  await call('POST', '/v1/schemes/scheme-kcc/apply', { device: dev });
  assert.equal(await count(), 2);

  // 3. an order placed, made ready, collected
  const placed = (await call('POST', '/v1/orders', { device: dev, body: { centerId, items: [{ productId: 'p-neemcake', quantity: 1 }] } })).json;
  await call('POST', `/v1/operator/orders/${placed.id}/ready`);
  await call('POST', `/v1/operator/orders/${placed.id}/verify-otp`, { body: { otp: placed.pickupOtp } });
  assert.equal(await count(), 5);

  const list = await call('GET', '/v1/farmer/notifications', { device: dev });
  assert.equal(list.json.length, 5);
  assert.equal(list.headers.get('x-total-count'), '5');
  assert.deepEqual(list.json.map((n) => n.title), [
    'Order collected',
    'Your order is ready for pickup',
    'Order placed',
    'Application submitted',
    'Soil scan complete',
  ]);
  assert.ok(list.json.every((n) => !('deviceId' in n) && n.read === false));
  assert.equal(list.json[4].type, 'scan');
  assert.equal(list.json[4].refId, scanRes.json.id);
  assert.equal(list.json[3].refId, 'scheme-kcc');
  assert.ok(list.json[1].body.includes(placed.pickupOtp));

  // isolation: another device sees none of it and cannot mark it read
  assert.deepEqual((await call('GET', '/v1/farmer/notifications', { device: 'other' })).json, []);
  assert.equal((await call('POST', `/v1/farmer/notifications/${list.json[0].id}/read`, { device: 'other' })).status, 404);

  // mark one read, filter unread, then read-all
  const one = await call('POST', `/v1/farmer/notifications/${list.json[0].id}/read`, { device: dev });
  assert.equal(one.json.read, true);
  assert.equal(await count(), 4);
  assert.equal((await call('GET', '/v1/farmer/notifications?unread=true', { device: dev })).json.length, 4);
  assert.equal((await call('POST', '/v1/farmer/notifications/read-all', { device: dev })).json.unreadCount, 0);
  assert.equal(await count(), 0);
  assert.equal((await call('POST', '/v1/farmer/notifications/nope/read', { device: dev })).status, 404);
  assert.equal((await call('GET', '/v1/farmer/notifications')).status, 400);

  // operator cancel notifies too
  const second = (await call('POST', '/v1/orders', { device: dev, body: { centerId, items: [{ productId: 'p-sprayer', quantity: 1 }] } })).json;
  await call('POST', `/v1/operator/orders/${second.id}/cancel`);
  const after = (await call('GET', '/v1/farmer/notifications', { device: dev })).json;
  assert.equal(after[0].title, 'Your order was cancelled');
});

test('migrations are idempotent and the starter data is only loaded once', async () => {
  const fs = require('fs');
  const path = require('path');
  const { openTestDb, closeTestDb } = require('./helpers');
  const { seedIfEmpty } = require('../src/db/seed');
  const migrationFileCount = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).length;
  const fresh = await openTestDb('t_migrate');
  try {
    await fresh.query("UPDATE products SET name = 'Edited' WHERE id = 'p-neemcake'");
    await fresh.migrate(); // second run: nothing to apply
    await seedIfEmpty(fresh); // second run: table is not empty, so nothing is re-inserted
    assert.equal((await fresh.one("SELECT name FROM products WHERE id = 'p-neemcake'")).name, 'Edited');
    assert.equal((await fresh.one('SELECT count(*)::int AS n FROM products')).n, 5);
    assert.equal((await fresh.one('SELECT count(*)::int AS n FROM schema_migrations')).n, migrationFileCount);
  } finally {
    await closeTestDb(fresh);
  }
});

test('search text is matched literally, not as LIKE wildcards', async () => {
  const all = (await call('GET', '/v1/products')).json.length;
  assert.ok(all > 1);
  // "%" would match every product if it were treated as a wildcard.
  assert.equal((await call('GET', '/v1/products?q=%25')).json.length, 0);
  assert.equal((await call('GET', '/v1/products?q=_')).json.length, 0);
});

test('X-Total-Count and paging come from SQL, and stay consistent with filters', async () => {
  const res = await fetch(base + '/v1/products?limit=2&offset=1');
  assert.equal(res.headers.get('x-total-count'), '5');
  assert.equal((await res.json()).length, 2);
});

test('concurrent requests cannot corrupt counters or double-apply', async () => {
  // Same-device concurrent like-toggling is covered in test/community.test.js
  // (its own suite, since community's like is a toggle, not an idempotent add).

  // Double-tapping "apply" submits one application and one notification.
  const results = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/v1/schemes/scheme-kcc/apply', { device: 'race-apply' })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 200).length, 5);
  const notes = (await call('GET', '/v1/farmer/notifications', { device: 'race-apply' })).json;
  assert.equal(notes.filter((n) => n.type === 'scheme').length, 1);

  // Ten simultaneous reviews all count toward the product's review total.
  const start = (await call('GET', '/v1/products/p-neemcake')).json.reviewCount;
  await Promise.all(Array.from({ length: 10 }, () =>
    call('POST', '/v1/products/p-neemcake/reviews', { body: { authorName: 'R', rating: 5, comment: 'ok' } })));
  assert.equal((await call('GET', '/v1/products/p-neemcake')).json.reviewCount, start + 10);
});

test('catalog lists keep their curated order, not alphabetical id order', async () => {
  const names = (await call('GET', '/v1/products')).json.map((p) => p.name);
  assert.equal(names[0], 'Vermicompost');
  assert.equal(names[1], 'Neem Cake');
});
