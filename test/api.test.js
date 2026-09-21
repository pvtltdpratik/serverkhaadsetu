process.env.NODE_ENV = 'test';
// These tests cover the anonymous X-Device-Id mode; auth has its own file.
process.env.SUPABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

let server;
let base;
let config;

// Stand-in for the external Soil Sense service. `analyzer.mode` picks the
// behaviour; `analyzer.lastRequest` records what was forwarded to it.
const analyzer = { mode: 'ok', lastRequest: null, server: null };

const startFakeAnalyzer = () =>
  new Promise((resolve) => {
    analyzer.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        analyzer.lastRequest = { method: req.method, url: req.url, contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('latin1') };
        const send = (status, payload) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
        };
        if (analyzer.mode === 'reject') return send(422, { detail: [{ msg: 'Uploaded file is not an image' }] });
        if (analyzer.mode === 'down') return send(500, { detail: 'boom' });
        if (analyzer.mode === 'garbage') return send(201, { hello: 'world' });
        if (analyzer.mode === 'slow') return; // never answers -> client times out
        send(201, {
          id: crypto.randomUUID(),
          // The real analyzer sends naive UTC: no trailing Z.
          created_at: new Date().toISOString().replace('Z', '000'),
          health_score: 71.4,
          soil_moisture: 52.3,
          nutrient_n: 38.2,
          nutrient_p: 66,
          nutrient_k: 74.5,
          disease: 'No significant disease indicators',
          disease_confidence: 88,
          recommendations: ['Nitrogen is low — apply vermicompost or neem cake before the next watering.'],
          metadata: null,
        });
      });
    });
    analyzer.server.listen(0, () => resolve(analyzer.server.address().port));
  });

test.before(async () => {
  const analyzerPort = await startFakeAnalyzer();
  process.env.SOIL_ANALYZER_URL = `http://127.0.0.1:${analyzerPort}/v1/analyze`;
  const { createStore } = require('../src/db/store');
  const { createApp } = require('../src/app');
  config = require('../src/config');
  const app = createApp(createStore(null));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  analyzer.server.close();
});

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

// The fake analyzer never decodes the bytes, so any payload will do.
const photo = async () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-bytes-0123456789')]);

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

  // The image and the plant type really were forwarded to the analyzer.
  const forwarded = analyzer.lastRequest;
  assert.equal(forwarded.method, 'POST');
  assert.equal(forwarded.url, '/v1/analyze');
  assert.match(forwarded.contentType, /^multipart\/form-data/);
  assert.ok(forwarded.body.includes('fake-jpeg-bytes-0123456789'));
  assert.ok(forwarded.body.includes('name="image"'));
  // Client said application/octet-stream; the analyzer must still see the real type.
  assert.match(forwarded.body, /content-type: image\/jpeg/i);
  assert.doesNotMatch(forwarded.body, /application\/octet-stream/i);
  assert.ok(forwarded.body.includes('"crop_type":"tomato"'));
  assert.ok(forwarded.body.includes('"device_id":"dev-soil"'));
  const scan = analyzed.json;
  for (const key of ['id', 'created_at', 'health_score', 'soil_moisture', 'nutrient_n', 'nutrient_p', 'nutrient_k', 'disease', 'disease_confidence']) {
    assert.ok(key in scan, `missing ${key}`);
  }
  // Naive analyzer time is normalised to explicit UTC, not shifted.
  assert.ok(scan.created_at.endsWith('Z'));
  assert.ok(Math.abs(Date.now() - Date.parse(scan.created_at)) < 60000);
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
  assert.ok(!analyzer.lastRequest.body.includes('crop_type'));
  assert.ok(!('crop_type' in bare.json.metadata));

  const plain = await call('POST', '/v1/analyze', { body: await scanForm({ device_id: 'dev-plain', plant_type: 'chilli' }, { asMetadata: false }) });
  assert.equal(plain.status, 200);
  assert.ok(analyzer.lastRequest.body.includes('"crop_type":"chilli"'));
  assert.equal(plain.json.metadata.crop_type, 'chilli');
});

test('soil: request problems are rejected before or relayed from the analyzer', async () => {
  const noImage = new FormData();
  noImage.append('metadata_json', JSON.stringify({ device_id: 'dev-many' }));
  assert.equal((await call('POST', '/v1/analyze', { body: noImage })).status, 400);

  const noDevice = await scanForm({});
  assert.equal((await call('POST', '/v1/analyze', { body: noDevice })).status, 400);

  analyzer.mode = 'reject';
  const rejected = await call('POST', '/v1/analyze', { body: await scanForm() });
  assert.equal(rejected.status, 422);
  assert.match(rejected.json.error, /not an image/);
  analyzer.mode = 'ok';
});

test('soil: analyzer failures become 502/504/503 and are never stored', async () => {
  const before = (await call('GET', '/v1/history?device_id=dev-fail')).json.length;

  for (const mode of ['down', 'garbage']) {
    analyzer.mode = mode;
    const res = await call('POST', '/v1/analyze', { body: await scanForm({ device_id: 'dev-fail' }) });
    assert.equal(res.status, 502, mode);
  }

  const originalTimeout = config.soilAnalyzerTimeoutMs;
  config.soilAnalyzerTimeoutMs = 150;
  analyzer.mode = 'slow';
  assert.equal((await call('POST', '/v1/analyze', { body: await scanForm({ device_id: 'dev-fail' }) })).status, 504);
  config.soilAnalyzerTimeoutMs = originalTimeout;
  analyzer.mode = 'ok';

  const originalUrl = config.soilAnalyzerUrl;
  config.soilAnalyzerUrl = '';
  assert.equal((await call('POST', '/v1/analyze', { body: await scanForm({ device_id: 'dev-fail' }) })).status, 503);
  config.soilAnalyzerUrl = 'http://127.0.0.1:1/v1/analyze'; // nothing listens here
  assert.equal((await call('POST', '/v1/analyze', { body: await scanForm({ device_id: 'dev-fail' }) })).status, 502);
  config.soilAnalyzerUrl = originalUrl;

  assert.equal((await call('GET', '/v1/history?device_id=dev-fail')).json.length, before);
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
  const placed = (await call('POST', '/v1/orders', { device: dev, body: { items: [{ productId: 'p-neemcake', quantity: 1 }] } })).json;
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

  // operator cancel notifies too; seeded/walk-in orders (no device) notify nobody
  const second = (await call('POST', '/v1/orders', { device: dev, body: { items: [{ productId: 'p-sprayer', quantity: 1 }] } })).json;
  await call('POST', `/v1/operator/orders/${second.id}/cancel`);
  const after = (await call('GET', '/v1/farmer/notifications', { device: dev })).json;
  assert.equal(after[0].title, 'Your order was cancelled');
  await call('POST', '/v1/operator/orders/order-1/ready');
  assert.equal((await call('GET', '/v1/farmer/notifications', { device: dev })).json.length, after.length);
});

test('store upgrade: an older db.json without new collections is backfilled', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createStore } = require('../src/db/store');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khaad-')), 'db.json');
  createStore(file);
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete old.notifications;
  old.profiles.push({ deviceId: 'keep-me', name: 'Kept', village: '', landHoldingHectares: 1 });
  fs.writeFileSync(file, JSON.stringify(old));

  const upgraded = createStore(file);
  assert.deepEqual(upgraded.data.notifications, []);
  assert.equal(upgraded.data.profiles[0].name, 'Kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).notifications, []);
});
