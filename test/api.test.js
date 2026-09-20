process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createStore } = require('../src/db/store');
const { createApp } = require('../src/app');

let server;
let base;

test.before(async () => {
  const app = createApp(createStore(null));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

const call = async (method, path, { body, device, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(device ? { 'x-device-id': device } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};

const greenPhoto = () =>
  sharp({ create: { width: 80, height: 80, channels: 3, background: { r: 60, g: 140, b: 60 } } }).jpeg().toBuffer();

test('health and 404', async () => {
  assert.equal((await call('GET', '/health')).json.status, 'ok');
  assert.equal((await call('GET', '/v1/nope')).status, 404);
});

test('soil: analyze -> history -> scan by id, matching the Flutter contract', async () => {
  const form = new FormData();
  form.append('metadata_json', JSON.stringify({ device_id: 'dev-soil', crop_type: 'tomato' }));
  // The Flutter client uploads as application/octet-stream.
  form.append('image', new Blob([await greenPhoto()], { type: 'application/octet-stream' }), 'scan.jpg');
  const analyzed = await call('POST', '/v1/analyze', { body: form });
  assert.equal(analyzed.status, 200);
  const scan = analyzed.json;
  for (const key of ['id', 'created_at', 'health_score', 'soil_moisture', 'nutrient_n', 'nutrient_p', 'nutrient_k', 'disease', 'disease_confidence']) {
    assert.ok(key in scan, `missing ${key}`);
  }
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

test('soil: keeps only the 5 newest scans and rejects bad uploads', async () => {
  for (let i = 0; i < 7; i++) {
    const form = new FormData();
    form.append('metadata_json', JSON.stringify({ device_id: 'dev-many' }));
    form.append('image', new Blob([await greenPhoto()]), 'scan.jpg');
    assert.equal((await call('POST', '/v1/analyze', { body: form })).status, 200);
  }
  assert.equal((await call('GET', '/v1/history?device_id=dev-many')).json.length, 5);

  const bad = new FormData();
  bad.append('metadata_json', JSON.stringify({ device_id: 'dev-many' }));
  bad.append('image', new Blob(['not an image']), 'x.jpg');
  assert.equal((await call('POST', '/v1/analyze', { body: bad })).status, 422);

  const noImage = new FormData();
  noImage.append('metadata_json', JSON.stringify({ device_id: 'dev-many' }));
  assert.equal((await call('POST', '/v1/analyze', { body: noImage })).status, 400);
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
    body: { name: 'Pratik Kolhe', village: 'Shirur, Pune', landHoldingHectares: 1.5, unreadNotificationCount: 3 },
  });
  assert.equal(put.json.name, 'Pratik Kolhe');
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

test('community: posts, filters, replies, likes', async () => {
  const posts = await call('GET', '/v1/community/posts');
  assert.equal(posts.json.length, 6);
  assert.ok(posts.json[0].replyCount >= 0);
  assert.equal((await call('GET', '/v1/community/posts?crop=wheat')).json.length, 2);
  assert.equal((await call('GET', '/v1/community/posts?problemType=pest')).json.length, 1);

  const created = await call('POST', '/v1/community/posts', {
    body: { authorName: 'Tester', title: 'Aphids on mustard', body: 'What organic spray works?', crop: 'Mustard', district: 'Pune', problemType: 'pest' },
  });
  assert.equal(created.status, 201);
  const id = created.json.id;
  assert.equal(created.json.replyCount, 0);

  const reply = await call('POST', `/v1/community/posts/${id}/replies`, { body: { authorName: 'Helper', body: 'Try neem oil.' } });
  assert.equal(reply.status, 201);
  assert.equal((await call('GET', `/v1/community/posts/${id}`)).json.replyCount, 1);
  assert.equal((await call('GET', `/v1/community/posts/${id}/replies`)).json.length, 1);

  const like1 = await call('POST', `/v1/community/posts/${id}/like`, { device: 'd1' });
  const like2 = await call('POST', `/v1/community/posts/${id}/like`, { device: 'd1' });
  assert.equal(like1.json.likeCount, 1);
  assert.equal(like2.json.likeCount, 1);
  assert.equal((await call('DELETE', `/v1/community/posts/${id}/like`, { device: 'd1' })).json.likeCount, 0);
  assert.ok(!('likedBy' in like1.json));
});

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
    body: { customerName: 'Tester', items: [{ productId: 'p-vermicompost', quantity: 2, unitPrice: 1 }] },
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

test('operator: seeded orders, walk-in sale, farmers, inventory, earnings', async () => {
  const orders = await call('GET', '/v1/operator/orders');
  assert.ok(orders.json.length >= 6);
  assert.ok(orders.json.every((o) => o.pickupOtp === null));
  assert.ok(orders.json.every((o) => !('deviceId' in o)));
  assert.equal((await call('GET', '/v1/operator/orders?status=pending')).json.every((o) => o.status === 'pending'), true);
  assert.equal((await call('GET', '/v1/operator/orders?status=bogus')).status, 400);

  const walkIn = await call('POST', '/v1/operator/orders/walk-in', {
    body: { customerName: 'Sita', items: [{ productName: 'Neem Cake', quantity: 2, unitPrice: 600 }] },
  });
  assert.equal(walkIn.status, 201);
  assert.equal(walkIn.json.status, 'completed');
  assert.equal(walkIn.json.totalAmount, 1200);
  assert.equal((await call('POST', '/v1/operator/orders/walk-in', { body: { items: [{ productName: 'x', quantity: 0, unitPrice: 1 }] } })).status, 400);

  assert.equal((await call('GET', '/v1/operator/farmers')).json.length, 6);
  assert.equal((await call('GET', '/v1/operator/farmers?needsFollowUp=true')).json.length, 3);
  assert.equal((await call('GET', '/v1/operator/farmers/farmer-ramesh')).json.activeCrop, 'Wheat');
  assert.equal((await call('GET', '/v1/operator/farmers/nope')).status, 404);

  const items = await call('GET', '/v1/operator/inventory/items');
  assert.equal(items.json.find((i) => i.id === 'inv-neemcake').isLowStock, true);
  const restock = await call('POST', '/v1/operator/inventory/restock-requests', { body: { itemId: 'inv-neemcake', quantity: 20 } });
  assert.equal(restock.status, 201);
  assert.equal(restock.json.status, 'pending');
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
