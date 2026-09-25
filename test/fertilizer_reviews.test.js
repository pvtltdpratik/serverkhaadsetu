process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.RATE_LIMIT_OTP = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const reviews = require('../src/services/fertilizerReviews');

let server;
let base;
let db;
let counter = 0;
let testImage;

const call = async (method, path, { body, device = 'rev-1' } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-device-id': device },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
};

test.before(async () => {
  const { openTestDb, testImage: image } = require('./helpers');
  const { createApp } = require('../src/app');
  testImage = image;
  db = await openTestDb('t_reviews');
  server = createApp(db).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

const makeCenter = async (key) => {
  counter += 1;
  const op = `op-${key}-${counter}`;
  await call('GET', '/v1/me', { device: op });
  const res = await call('POST', '/v1/admin/centers', {
    device: 'admin', body: { name: `Center ${key}`, village: key, district: 'Yavatmal', latitude: 18.5 + counter * 0.5, longitude: 74.0, operatorId: op, opensAt: '00:00', closesAt: '23:59' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  await call('POST', '/v1/operator/inventory/receive', { device: op, body: { productId: 'p-vermicompost', quantity: 200 } });
  return { ...res.json, device: op };
};

let center;
// A farmer who collected a bag of vermicompost, with a farm profile and a soil scan.
const farmer = async (name, { soil = 'black', acres = 3, irrigation = 'rainfed', scan = [30, 55, 60], details = true } = {}) => {
  if (!center) center = await makeCenter('rev');
  const device = `farmer-${name}-${(counter += 1)}`;
  await call('PUT', '/v1/farmer/profile', { device, body: { name: `${name} Patil`, village: 'Shirur', landHoldingHectares: acres / 2.471 } });
  await call('POST', '/v1/farmer/addresses', { device, body: { fullName: name, phone: '9822011111', line1: 'Gat 1', pincode: '445001', district: 'Yavatmal' } });
  if (details) await call('PUT', '/v1/farmer/details', { device, body: { soilType: soil, irrigation } });
  if (scan) {
    await db.query(
      `INSERT INTO scans (id, owner_id, created_at, health_score, soil_moisture, nutrient_n, nutrient_p, nutrient_k, disease, disease_confidence)
       VALUES ($1, $2, now() - interval '1 day', 48, 40, $3, $4, $5, 'none', 0)`, [`scan-${device}`, device, scan[0], scan[1], scan[2]],
    );
  }
  const order = (await call('POST', '/v1/orders', { device, body: { centerId: center.centerId, items: [{ productId: 'p-vermicompost', quantity: 2 }] } })).json;
  await call('POST', `/v1/operator/orders/${order.id}/ready`, { device: center.device });
  const done = await call('POST', `/v1/operator/orders/${order.id}/verify-otp`, { device: center.device, body: { otp: order.pickupOtp } });
  assert.equal(done.status, 200, done.text);
  return device;
};

const phase1 = (over = {}) => ({ productId: 'p-vermicompost', acres: 3, crop: 'Soybean', variety: 'JS 335', growthStage: 'vegetative', qtyPerAcre: 25, method: 'broadcasting', reason: 'app_recommendation', ...over });
const post = (over = {}) => ({ yieldQpa: 11.2, lastSeasonQpa: 8.4, starsOverall: 5, starsValue: 4, starsEase: 5, useAgain: 'yes', recommend: true, comment: 'सुरुवातीला शंका होती पण पिकाचा रंग बदलला.', ...over });
const daysAgo = (id, days) => db.query("UPDATE fertilizer_review SET phase1_at = now() - ($2 || ' days')::interval WHERE review_id = $1", [id, String(days)]);

// One farmer taken all the way to a published harvest log.
const publish = async (name, opts = {}, p1 = {}, p3 = {}) => {
  const device = await farmer(name, opts);
  const started = await call('POST', '/v1/reviews', { device, body: phase1(p1) });
  assert.equal(started.status, 201, started.text);
  const id = started.json.review.reviewId;
  await daysAgo(id, 60);
  const finished = await call('POST', `/v1/reviews/${id}/post`, { device, body: post(p3) });
  assert.equal(finished.status, 200, finished.text);
  return { device, id, finished: finished.json };
};

// ---- the rules -------------------------------------------------------------------------------------

test('farm size, nutrient level and season order', () => {
  assert.deepEqual([1.9, 2, 5, 5.1].map(reviews.sizeClass), ['small', 'medium', 'medium', 'large']);
  assert.deepEqual([10, 39.9, 40, 69.9, 70, 100].map(reviews.levelOf), ['low', 'low', 'medium', 'medium', 'high', 'high']);
  const n = (s) => reviews.seasonNumber(s);
  assert.equal(n('rabi-2025') - n('kharif-2025'), 1);
  assert.equal(n('kharif-2026') - n('rabi-2025'), 1);
  assert.equal(n('zaid-2026'), null);
});

test('the streak counts consecutive Kharif and Rabi seasons, ends at the latest, and ignores Zaid', () => {
  const streak = reviews.currentStreak;
  assert.equal(streak([]), 0);
  assert.equal(streak(['kharif-2025']), 1);
  assert.equal(streak(['kharif-2025', 'rabi-2025', 'kharif-2026']), 3);
  assert.equal(streak(['kharif-2025', 'kharif-2026']), 1, 'a missed Rabi breaks it');
  assert.equal(streak(['kharif-2024', 'rabi-2025', 'kharif-2026', 'rabi-2026']), 3, 'only the run at the end counts');
  assert.equal(streak(['kharif-2025', 'zaid-2026', 'rabi-2025', 'kharif-2026']), 3, 'Zaid is ignored');
  assert.equal(streak(['rabi-2025', 'rabi-2025', 'kharif-2026']), 2, 'twice in one season counts once');
});

test('improvement is against the farmer\'s own last season, else the district average', () => {
  assert.deepEqual(reviews.improvement({ yieldQpa: 11.2, lastSeasonQpa: 8.4, districtAvgQpa: 9.2 }), { baseline: 8.4, pct: 33.3 });
  assert.deepEqual(reviews.improvement({ yieldQpa: 11.2, districtAvgQpa: 9.2 }), { baseline: 9.2, pct: 21.7 });
  assert.deepEqual(reviews.improvement({ yieldQpa: 7 }), { baseline: null, pct: null });
});

test('an unusual yield is held for an agronomist, a normal one is not', () => {
  const r = reviews.outlierReason;
  assert.equal(r({ pct: 33.3, yieldQpa: 11.2, districtAvgQpa: 9.2 }), '');
  assert.match(r({ pct: 120, yieldQpa: 20, districtAvgQpa: 9.2 }), /above the reference/);
  assert.match(r({ pct: -70, yieldQpa: 3, districtAvgQpa: 9.2 }), /very poor/);
  assert.match(r({ pct: 10, yieldQpa: 30, districtAvgQpa: 9.2 }), /three times the district average/);
  assert.equal(r({ pct: null, yieldQpa: 5, districtAvgQpa: null }), '');
});

test('the summary is worked out from the data: best case, what it is good for, and what to watch', () => {
  const row = (o) => ({ soil_type: 'black', crop: 'Soybean', season: 'kharif-2026', irrigation: 'well', improvement_pct: 20, stars_overall: 4, stars_value: 5, stars_ease: 5, use_again: 'yes', npk_before: { n: 'low', p: 'medium', k: 'medium' }, ...o });
  const rows = [
    row({}), row({ improvement_pct: 24 }), row({ improvement_pct: 22 }),
    row({ soil_type: 'sandy', improvement_pct: 4, irrigation: 'rainfed', npk_before: { n: 'high', p: 'high', k: 'high' } }),
    row({ soil_type: 'sandy', improvement_pct: 6, irrigation: 'rainfed', npk_before: { n: 'high', p: 'high', k: 'high' } }),
  ];
  const s = reviews.summarize(rows);
  assert.equal(s.count, 5);
  assert.equal(s.overall, 4);
  assert.equal(s.improvementAvg, 15.2);
  assert.deepEqual(s.best, { soil: 'black', crop: 'Soybean', season: 'kharif', averagePct: 22, reviews: 3 });
  assert.deepEqual(s.topRatedFor, ['Value for money', 'Easy to apply', 'Nitrogen deficiency correction']);
  assert.deepEqual(s.watchOutFor, ['Less effective on sandy soil', 'Needs good moisture at the time of application']);
  assert.deepEqual(reviews.summarize([]), { count: 0, overall: null, improvementAvg: null, best: null, topRatedFor: [], watchOutFor: [] });
  assert.match(reviews.summarize([row({ use_again: 'no' }), row({ use_again: 'no' }), row({})]).watchOutFor.join(), /67% would not use it again/);
});

// ---- phase 1 ---------------------------------------------------------------------------------------

test('phase 1 needs a collected purchase and the farmer\'s own soil type, and fills the baseline from the latest scan', async () => {
  const stranger = 'never-bought';
  assert.equal((await call('POST', '/v1/reviews', { device: stranger, body: phase1() })).status, 409, 'no purchase, no review');

  const noSoil = await farmer('nosoil', { details: false });
  const refused = await call('POST', '/v1/reviews', { device: noSoil, body: phase1() });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /soil type/);

  const d = await farmer('base');
  const pre = (await call('GET', '/v1/reviews/prefill/p-vermicompost', { device: d })).json;
  assert.equal(pre.eligible, true);
  assert.equal(pre.soilType, 'black');
  assert.equal(pre.irrigation, 'rainfed');
  assert.equal(pre.acres, 3);
  assert.equal(pre.district, 'Yavatmal');
  assert.deepEqual(pre.scan.npk, { n: 'low', p: 'medium', k: 'medium', nValue: 30, pValue: 55, kValue: 60 });
  assert.equal(pre.scan.score, 48);

  const bad = (over) => call('POST', '/v1/reviews', { device: d, body: phase1(over) });
  assert.equal((await bad({ crop: 'Dragonfruit' })).status, 400);
  assert.equal((await bad({ acres: 0 })).status, 400);
  assert.equal((await bad({ method: 'sprinkling' })).status, 400);
  assert.equal((await bad({ growthStage: 'harvest' })).status, 400);
  assert.equal((await bad({ appliedOn: '2099-01-01' })).status, 400);
  assert.equal((await bad({ productId: 'p-biopesticide' })).status, 409);

  const ok = await call('POST', '/v1/reviews', { device: d, body: phase1() });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.review.phase, 1);
  assert.equal(ok.json.review.soilType, 'black');
  assert.equal(ok.json.coupon.percent, 5);
  assert.match(ok.json.coupon.code, /^SAMRUDHI-[0-9A-F]{6}$/);
  const row = (await db.query('SELECT * FROM fertilizer_review WHERE review_id = $1', [ok.json.review.reviewId])).rows[0];
  assert.deepEqual(row.npk_before, { n: 'low', p: 'medium', k: 'medium', nValue: 30, pValue: 55, kValue: 60 });
  assert.equal(row.score_before, 48);
  assert.equal(row.size_class, 'medium');
  assert.equal(row.district, 'Yavatmal');
  assert.equal((await bad({})).status, 409, 'once per fertilizer, crop and season');
  assert.ok((await call('GET', '/v1/farmer/notifications', { device: d })).json.some((n) => /5% off/.test(n.title)));
  assert.equal((await call('GET', '/v1/reviews/mine', { device: d })).json.length, 1);
});

test('a farmer can only fill in their own log', async () => {
  const d = await farmer('owner');
  const id = (await call('POST', '/v1/reviews', { device: d, body: phase1() })).json.review.reviewId;
  assert.equal((await call('POST', `/v1/reviews/${id}/mid`, { device: 'someone', body: { colorChange: 'improved', leafHealth: 'greener', pestDisease: false, soilFeel: 'better' } })).status, 404);
  assert.equal((await call('POST', `/v1/reviews/${id}/post`, { device: 'someone', body: post() })).status, 404);
});

// ---- phase 2 and 3 ---------------------------------------------------------------------------------

test('phase 2 opens about four weeks after phase 1, once, and earns coins', async () => {
  const d = await farmer('mid');
  const id = (await call('POST', '/v1/reviews', { device: d, body: phase1() })).json.review.reviewId;
  const notes = { colorChange: 'improved', leafHealth: 'greener', pestDisease: false, soilFeel: 'better', unexpected: 'Fewer weeds' };
  const early = await call('POST', `/v1/reviews/${id}/mid`, { device: d, body: notes });
  assert.equal(early.status, 409);
  assert.match(early.json.error, /28 days from now/);
  assert.equal((await call('GET', '/v1/reviews/mine', { device: d })).json[0].midOpensInDays, 28);

  await daysAgo(id, 30);
  assert.equal((await call('POST', `/v1/reviews/${id}/mid`, { device: d, body: { ...notes, colorChange: 'bad' } })).status, 400);
  const ok = await call('POST', `/v1/reviews/${id}/mid`, { device: d, body: notes });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.coins, 10);
  assert.equal(ok.json.review.phase, 2);
  assert.equal((await call('POST', `/v1/reviews/${id}/mid`, { device: d, body: notes })).status, 409, 'once');
  assert.equal((await call('GET', '/v1/reviews/rewards', { device: d })).json.coins, 10);

  // A photo can be added to it.
  const form = new FormData();
  form.append('file', new Blob([await testImage()], { type: 'image/jpeg' }), 'crop.jpg');
  const up = await fetch(`${base}/v1/reviews/${id}/photos/mid`, { method: 'POST', headers: { 'x-device-id': d }, body: form });
  assert.equal(up.status, 201);
  const bad = new FormData();
  bad.append('file', new Blob([Buffer.from('not an image')]), 'x.jpg');
  assert.equal((await fetch(`${base}/v1/reviews/${id}/photos/mid`, { method: 'POST', headers: { 'x-device-id': d }, body: bad })).status, 422);
});

test('phase 3 needs a growing season after phase 1, and records the yield against last season and the district', async () => {
  const d = await farmer('harvest');
  const id = (await call('POST', '/v1/reviews', { device: d, body: phase1() })).json.review.reviewId;
  const early = await call('POST', `/v1/reviews/${id}/post`, { device: d, body: post() });
  assert.equal(early.status, 409);
  assert.match(early.json.error, /45 days from now/);

  await daysAgo(id, 100);
  for (const over of [{ starsOverall: 0 }, { starsValue: 6 }, { useAgain: 'perhaps' }, { yieldQpa: 0 }, { recommend: 'yes' }]) {
    assert.equal((await call('POST', `/v1/reviews/${id}/post`, { device: d, body: post(over) })).status, 400, JSON.stringify(over));
  }
  const ok = await call('POST', `/v1/reviews/${id}/post`, { device: d, body: post() });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.improvementPct, 33.3);
  assert.equal(ok.json.districtAvgQpa, 9.2);
  assert.equal(ok.json.review.status, 'published');
  const row = (await db.query('SELECT * FROM fertilizer_review WHERE review_id = $1', [id])).rows[0];
  assert.equal(Number(row.baseline_qpa), 8.4);
  assert.equal(row.stars_overall, 5);
  assert.equal(row.comment, 'सुरुवातीला शंका होती पण पिकाचा रंग बदलला.');
  assert.equal((await call('POST', `/v1/reviews/${id}/post`, { device: d, body: post() })).status, 409, 'once');
  // Not on the phase 3 path without phase 1 at all.
  assert.equal((await call('POST', '/v1/reviews/frev-nope/post', { device: d, body: post() })).status, 404);
});

test('finishing a harvest log pays coins, a Verified Farmer badge and priority access; a new soil scan is picked up', async () => {
  const d = await farmer('rewards');
  const id = (await call('POST', '/v1/reviews', { device: d, body: phase1() })).json.review.reviewId;
  await daysAgo(id, 90);
  await db.query(
    `INSERT INTO scans (id, owner_id, created_at, health_score, soil_moisture, nutrient_n, nutrient_p, nutrient_k, disease, disease_confidence)
     VALUES ('scan-after-rewards', $1, now(), 63, 40, 65, 72, 55, 'none', 0)`, [d],
  );
  const r = await call('POST', `/v1/reviews/${id}/post`, { device: d, body: post() });
  assert.deepEqual(r.json.earned, ['50 coins', "priority access to next season's recommendations", 'the Verified Farmer badge']);
  const row = (await db.query('SELECT score_after, npk_after FROM fertilizer_review WHERE review_id = $1', [id])).rows[0];
  assert.equal(row.score_after, 63);
  assert.deepEqual([row.npk_after.n, row.npk_after.p, row.npk_after.k], ['medium', 'high', 'medium']);
  const rewards = (await call('GET', '/v1/reviews/rewards', { device: d })).json;
  assert.equal(rewards.coins, 50);
  assert.deepEqual(rewards.badges.map((b) => b.badge), ['verified_farmer']);
  assert.ok(rewards.priorityUntil);
  assert.equal(rewards.completedSeasons, 1);
});

// ---- trust ------------------------------------------------------------------------------------------

test('an outlier is held for an agronomist: not shown until validated, and a rejected one never is', async () => {
  const a = await publish('outlier1', {}, { crop: 'Wheat' }, { yieldQpa: 40, lastSeasonQpa: 12 });
  assert.equal(a.finished.review.status, 'flagged');
  assert.match(a.finished.review.flagReason, /above the reference/);
  assert.equal((await call('GET', '/v1/reviews/product/p-vermicompost?crop=Wheat')).json.matching, 0, 'not published yet');

  const held = (await call('GET', '/v1/admin/reviews/flagged', { device: 'admin' })).json;
  assert.ok(held.some((h) => h.reviewId === a.id && h.yieldQpa === 40));
  assert.equal((await call('POST', `/v1/admin/reviews/${a.id}/decide`, { device: 'admin', body: { decision: 'maybe' } })).status, 400);
  const ok = await call('POST', `/v1/admin/reviews/${a.id}/decide`, { device: 'admin', body: { decision: 'validate', note: 'Irrigated, good seed: plausible' } });
  assert.deepEqual(ok.json, { reviewId: a.id, status: 'published' });
  const shown = (await call('GET', '/v1/reviews/product/p-vermicompost?crop=Wheat')).json;
  assert.equal(shown.matching, 1);
  assert.equal(shown.reviews[0].agronomistReviewed, true);
  assert.equal((await call('POST', `/v1/admin/reviews/${a.id}/decide`, { device: 'admin', body: { decision: 'reject' } })).status, 409, 'decided once');

  const b = await publish('outlier2', {}, { crop: 'Gram' }, { yieldQpa: 40, lastSeasonQpa: 5 });
  assert.equal(b.finished.review.status, 'flagged');
  await call('POST', `/v1/admin/reviews/${b.id}/decide`, { device: 'admin', body: { decision: 'reject', note: 'Could not confirm' } });
  assert.equal((await call('GET', '/v1/reviews/product/p-vermicompost?crop=Gram')).json.matching, 0);
  assert.ok((await call('GET', '/v1/farmer/notifications', { device: b.device })).json.some((n) => n.title === 'Your harvest log was not published'));
});

test('featuring a story tells the farmer and their center to hand over a certificate', async () => {
  const p = await publish('featured', {}, { crop: 'Maize' }, { yieldQpa: 20, lastSeasonQpa: 16 });
  await call('PUT', '/v1/farmer/profile', { device: p.device, body: { homeCenterId: center.centerId } });
  assert.equal((await call('POST', `/v1/admin/reviews/${p.id}/feature`, { device: 'admin' })).status, 200);
  assert.ok((await call('GET', '/v1/farmer/notifications', { device: p.device })).json.some((n) => n.title === 'Your story was featured'));
  assert.ok((await call('GET', '/v1/farmer/notifications', { device: center.device })).json.some((n) => n.title === 'Print a certificate'));
  const list = (await call('GET', '/v1/reviews/product/p-vermicompost?crop=Maize')).json;
  assert.equal(list.reviews[0].featured, true);
  const held = await publish('notfeat', {}, { crop: 'Onion' }, { yieldQpa: 500, lastSeasonQpa: 100 });
  assert.equal((await call('POST', `/v1/admin/reviews/${held.id}/feature`, { device: 'admin' })).status, 409, 'only published stories');
});

// ---- what other farmers see -----------------------------------------------------------------------

test('a product\'s reviews show a summary, and can be filtered to farmers like you', async () => {
  const rows = [
    ['kishor', { soil: 'black', acres: 3 }, { crop: 'Jowar', acres: 3 }, { yieldQpa: 7.5, lastSeasonQpa: 6 }],
    ['ravi', { soil: 'black', acres: 1.5, irrigation: 'well' }, { crop: 'Jowar', acres: 1.5 }, { yieldQpa: 7.2, lastSeasonQpa: 6 }],
    ['sanjay', { soil: 'red', acres: 8, irrigation: 'canal' }, { crop: 'Jowar', acres: 8 }, { yieldQpa: 5.7, lastSeasonQpa: 6 }],
  ];
  for (const [name, opts, p1, p3] of rows) await publish(name, opts, p1, p3);
  const all = (await call('GET', '/v1/reviews/product/p-vermicompost?crop=Jowar')).json;
  assert.equal(all.matching, 3);
  assert.equal(all.summary.count >= 3, true);

  const black = (await call('GET', '/v1/reviews/product/p-vermicompost?crop=Jowar&soil=black')).json;
  assert.equal(black.matching, 2);
  assert.ok(black.reviews.every((r) => r.soilType === 'black' && r.verifiedPurchase));
  assert.equal(black.summary.count, all.summary.count, 'the summary covers all reviews, the list is filtered');
  assert.equal((await call('GET', '/v1/reviews/product/p-vermicompost?crop=Jowar&size=small')).json.matching, 1);
  assert.equal((await call('GET', '/v1/reviews/product/p-vermicompost?crop=Jowar&size=large')).json.matching, 1);
  assert.equal((await call('GET', '/v1/reviews/product/p-vermicompost?crop=Jowar&improved=1')).json.matching, 2, 'only where yield improved');
  assert.equal((await call('GET', '/v1/reviews/product/p-vermicompost?crop=Jowar&district=yavatmal')).json.matching, 3);
  assert.equal((await call('GET', '/v1/reviews/product/p-vermicompost?crop=Jowar&district=nagpur')).json.matching, 0);
  assert.equal((await call('GET', '/v1/reviews/product/p-vermicompost?soil=clay')).status, 400);
  assert.equal((await call('GET', '/v1/reviews/product/p-vermicompost?season=kharif')).status, 200);

  const card = black.reviews[0];
  assert.match(card.farmer, /^(kishor|ravi) from Yavatmal$/i, 'first name and district only');
  assert.ok(!JSON.stringify(card).includes('Patil'), 'the surname stays private');
  assert.equal(card.crop, 'Jowar');
  assert.deepEqual(Object.keys(card.npkBefore).sort(), ['k', 'kValue', 'n', 'nValue', 'p', 'pValue']);
  assert.equal(card.scoreBefore, 48);
  assert.equal(card.qtyPerAcre, 25);
  assert.equal(card.lastSeasonQpa, 6);
  assert.equal(card.districtAvgQpa, 6);
  assert.equal(card.useAgain, 'yes');
});

test('the yield prediction uses real outcomes for the crop and soil when there are enough, else the nutrient the product supplies', async () => {
  const d = await farmer('predict', { soil: 'black', acres: 2, scan: [25, 60, 60] });
  // Soybean has too few reviews on black soil yet: it falls back to how the product works.
  await db.query("UPDATE fertilizer_review SET status = 'hidden' WHERE crop = 'Soybean'");
  const early = (await call('GET', '/v1/reviews/product/p-vermicompost/prediction?acres=2&crop=Soybean', { device: d })).json;
  assert.equal(early.basis, 'agronomy');
  assert.deepEqual([early.lowPct, early.highPct], [12, 20], 'nitrogen is low in the scan and vermicompost supplies it');
  assert.equal(early.matched, 'your soil scan');
  assert.match(early.message, /2-acre black-soil soybean farm .* 12% to 20% more yield/);
  assert.deepEqual(early.expectedExtraQuintals, { low: 2.2, high: 3.7 });

  // Three farmers with black soil growing Bajra (10%, 20% and 30% up): now it speaks from their results.
  for (const [n, y] of [['w1', 6.6], ['w2', 7.2], ['w3', 7.8]]) await publish(n, { soil: 'black' }, { crop: 'Bajra' }, { yieldQpa: y, lastSeasonQpa: 6 });
  await call('PUT', '/v1/farmer/details', { device: d, body: { soilType: 'black' } });
  const real = (await call('GET', '/v1/reviews/product/p-vermicompost/prediction?acres=2&crop=Bajra', { device: d })).json;
  assert.equal(real.basis, 'reviews');
  assert.equal(real.sampleSize, 3);
  assert.equal(real.matched, 'your crop and soil type');
  assert.deepEqual([real.lowPct, real.highPct], [15, 25], 'the middle half of what farmers like you got');
  assert.deepEqual(real.expectedExtraQuintals, { low: 1.7, high: 2.8 });
  assert.match(real.disclaimer, /farmers with your crop and soil type/);
  assert.equal((await call('GET', '/v1/reviews/product/p-vermicompost/prediction?acres=2&crop=Dragonfruit', { device: d })).status, 400);
  assert.equal((await call('GET', '/v1/reviews/product/p-vermicompost/prediction?crop=Bajra', { device: d })).status, 400);
  assert.equal((await call('GET', '/v1/reviews/product/nope/prediction?acres=2&crop=Bajra', { device: d })).status, 404);
});

// ---- rewards ----------------------------------------------------------------------------------------

test('three seasons in a row make a Champion Farmer, with a bigger coupon', async () => {
  const d = await farmer('champ');
  const at = (s) => new Date(`${s}T12:00:00Z`);
  const log = async (start, finish) => {
    const started = await reviews.startPhase1(db, { owner: d, productId: 'p-vermicompost', now: at(start), input: { acres: 3, crop: 'Soybean', growthStage: 'sowing', irrigation: 'rainfed', qtyPerAcre: 20, method: 'broadcasting', reason: 'used_before', appliedOn: start } });
    return reviews.submitPost(db, { owner: d, id: started.review.reviewId, now: at(finish), input: { yieldQpa: 10, lastSeasonQpa: 9, starsOverall: 5, starsValue: 5, starsEase: 5, useAgain: 'yes', recommend: true } });
  };
  const first = await log('2025-07-01', '2025-09-15');
  assert.equal(first.streak, 1);
  const second = await log('2025-12-01', '2026-02-20');
  assert.equal(second.streak, 2);
  assert.equal(second.championCoupon, null);
  const third = await log('2026-07-01', '2026-09-15');
  assert.equal(third.streak, 3);
  assert.match(third.championCoupon, /^SAMRUDHI-/);
  assert.ok(third.earned.includes('the Champion Farmer badge'));
  const rewards = (await call('GET', '/v1/reviews/rewards', { device: d })).json;
  assert.deepEqual(rewards.badges.map((b) => b.badge).sort(), ['champion_farmer', 'verified_farmer']);
  assert.equal(rewards.streak, 3);
  assert.equal(rewards.coupons.find((k) => k.code === third.championCoupon).percent, 10);
  const fourth = await log('2026-12-01', '2027-02-20');
  assert.equal(fourth.streak, 4);
  assert.equal(fourth.championCoupon, null, 'the badge is earned once');
});

test('coins are redeemed in hundreds for wallet money', async () => {
  const d = await farmer('coins');
  await db.query("INSERT INTO farmer_reward (reward_id, owner_id, kind, amount) VALUES ('rw-t1', $1, 'coins', 250)", [d]);
  assert.equal((await call('POST', '/v1/reviews/rewards/redeem', { device: d, body: { coins: 150 } })).status, 400, 'multiples of 100');
  assert.equal((await call('POST', '/v1/reviews/rewards/redeem', { device: d, body: { coins: 300 } })).status, 409, 'not enough');
  const r = await call('POST', '/v1/reviews/rewards/redeem', { device: d, body: { coins: 200 } });
  assert.deepEqual(r.json, { redeemed: 200, rupees: 50, coins: 50 });
  assert.equal((await call('GET', '/v1/wallet', { device: d })).json.balance, 50);
  assert.equal((await call('GET', '/v1/reviews/rewards', { device: d })).json.coins, 50);
});

test('a coupon takes a percentage off regular products, once, and comes back if the order is cancelled', async () => {
  const d = await farmer('coupon');
  const code = (await call('POST', '/v1/reviews', { device: d, body: phase1() })).json.coupon.code;
  const order = (extra) => call('POST', '/v1/orders', { device: d, body: { centerId: center.centerId, items: [{ productId: 'p-vermicompost', quantity: 2 }], ...extra } });

  assert.equal((await order({ couponCode: 'SAMRUDHI-NOPE00' })).status, 404);
  const other = await farmer('coupon-other');
  assert.equal((await call('POST', '/v1/orders', { device: other, body: { centerId: center.centerId, items: [{ productId: 'p-vermicompost', quantity: 1 }], couponCode: code } })).status, 404, 'not theirs');

  const placed = await order({ couponCode: code.toLowerCase() });
  assert.equal(placed.status, 201, placed.text);
  assert.equal(placed.json.discountPercent, 5);
  assert.equal(placed.json.items[0].unitPrice, 427.5, '450 less 5%');
  assert.equal(placed.json.totalAmount, 855);
  assert.equal(placed.json.couponCode, code);
  const reuse = await order({ couponCode: code });
  assert.equal(reuse.status, 409);
  assert.match(reuse.json.error, /already used/);
  // The discounted price is what gets paid, everywhere.
  const paid = await call('POST', '/v1/payments/orders', { device: d, body: { orderId: placed.json.id } });
  assert.equal(paid.status === 201 || paid.status === 503, true);

  assert.equal((await call('POST', `/v1/orders/${placed.json.id}/cancel`, { device: d })).status, 200);
  const again = await order({ couponCode: code });
  assert.equal(again.status, 201, 'the coupon came back with the cancelled order');

  await db.query("UPDATE farmer_coupon SET used_order_id = NULL, expires_at = now() - interval '1 day' WHERE code = $1", [code]);
  const expired = await order({ couponCode: code });
  assert.equal(expired.status, 409);
  assert.match(expired.json.error, /expired/);
});

test('reference data and the training export', async () => {
  const crops = (await call('GET', '/v1/reviews/reference/crops')).json;
  const soy = crops.find((c) => c.name === 'Soybean');
  assert.deepEqual([soy.msp, soy.districtAvgQpa], [5328, 9.2]);
  const data = (await call('GET', '/v1/admin/reviews/training-data', { device: 'admin' })).json;
  assert.ok(data.length >= 5);
  const rec = data.find((r) => r.crop === 'Jowar');
  for (const key of ['soilType', 'acres', 'irrigation', 'qtyPerAcre', 'method', 'npkBefore', 'scoreBefore', 'yieldQpa', 'improvementPct', 'scoreAfter', 'starsOverall']) assert.ok(key in rec, key);
  assert.ok(!data.some((r) => r.reviewId.includes('nope')));
  assert.ok(!JSON.stringify(data).includes('Patil'), 'no personal names in the training data');
});
