process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.RATE_LIMIT_OTP = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const resale = require('../src/services/resale');

let server;
let base;
let db;
let counter = 0;
let testImage;

const call = async (method, path, { body, device = 'seller-1' } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-device-id': device },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
};

const upload = async (device, id, kind, buffer) => {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), 'bag.jpg');
  return fetch(`${base}/v1/resale/${id}/photos/${kind}`, { method: 'POST', headers: { 'x-device-id': device }, body: form });
};

const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test.before(async () => {
  const { openTestDb, testImage: image } = require('./helpers');
  const { createApp } = require('../src/app');
  testImage = image;
  db = await openTestDb('t_resale');
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
    device: 'admin', body: { name: `Center ${key}`, village: key, district: 'Pune', latitude: 18.5 + counter * 0.5, longitude: 74.0, operatorId: op, opensAt: '00:00', closesAt: '23:59' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  for (const p of ['p-vermicompost', 'p-neemcake']) await call('POST', '/v1/operator/inventory/receive', { device: op, body: { productId: p, quantity: 100 } });
  return { ...res.json, device: op };
};

// A farmer who bought `quantity` bags of vermicompost from the center and collected them.
const buyAndCollect = async (center, farmer, quantity = 5, productId = 'p-vermicompost') => {
  const order = (await call('POST', '/v1/orders', { device: farmer, body: { centerId: center.centerId, items: [{ productId, quantity }] } })).json;
  assert.ok(order.id, JSON.stringify(order));
  await call('POST', `/v1/operator/orders/${order.id}/ready`, { device: center.device });
  const done = await call('POST', `/v1/operator/orders/${order.id}/verify-otp`, { device: center.device, body: { otp: order.pickupOtp } });
  assert.equal(done.status, 200, done.text);
  return order;
};

const listing = (center, over = {}) => ({
  productId: 'p-vermicompost', units: 2, condition: 'sealed', mfgDate: daysFromNow(-60), expiryDate: daysFromNow(400), batchNumber: 'B-2201',
  askingPrice: 380, centerId: center.centerId, payoutMode: 'wallet', ...over,
});

// Draft, both photos, submit.
const submitListing = async (center, farmer, over = {}) => {
  const draft = await call('POST', '/v1/resale', { device: farmer, body: listing(center, over) });
  assert.equal(draft.status, 201, draft.text);
  const id = draft.json.id;
  assert.equal((await upload(farmer, id, 'front', await testImage())).status, 201);
  assert.equal((await upload(farmer, id, 'back', await testImage())).status, 201);
  const sent = await call('POST', `/v1/resale/${id}/submit`, { device: farmer });
  assert.equal(sent.status, 200, sent.text);
  return sent.json;
};

const checklist = (over = {}) => ({
  productMatches: true, seal: 'sealed', units: 2, mfgDate: daysFromNow(-60), expiryDate: daysFromNow(400), batchNumber: 'B-2201', visual: 'free_flowing', purchaseProofSeen: true, ...over,
});

const wallet = async (device) => (await call('GET', '/v1/wallet', { device })).json;
const surplusNear = async (center, device = 'browser') =>
  (await call('POST', '/v1/centers/surplus', { device, body: { latitude: center.latitude, longitude: center.longitude, locationSource: 'gps' } })).json.lots;

// Buys the lot and returns the order.
const buy = async (lotId, buyer, quantity = 1, centerId) => {
  const r = await call('POST', '/v1/orders', { device: buyer, body: { centerId, items: [{ surplusLotId: lotId, quantity }] } });
  assert.equal(r.status, 201, r.text);
  return r.json;
};
const collect = async (center, order) => {
  const ready = await call('POST', `/v1/operator/orders/${order.id}/ready`, { device: center.device });
  assert.equal(ready.status, 200, ready.text);
  return call('POST', `/v1/operator/orders/${order.id}/verify-otp`, { device: center.device, body: { otp: order.pickupOtp } });
};

// ---- the rules ------------------------------------------------------------------------------------

test('seasons: Kharif June to October, Rabi November to March (across the new year), Zaid April and May', () => {
  const at = (s) => resale.seasonOf(new Date(`${s}T12:00:00Z`));
  assert.equal(at('2026-06-01'), 'kharif-2026');
  assert.equal(at('2026-10-31'), 'kharif-2026');
  assert.equal(at('2026-11-01'), 'rabi-2026');
  assert.equal(at('2027-02-15'), 'rabi-2026');
  assert.equal(at('2027-03-31'), 'rabi-2026');
  assert.equal(at('2027-04-10'), 'zaid-2027');
  assert.equal(at('2027-05-31'), 'zaid-2027');
});

test('the suggested price is the platform price x condition x age, kept between 40% and 90%', () => {
  const today = new Date('2026-09-26T00:00:00Z');
  const guide = (o) => resale.priceGuide({ catalogPrice: 450, today, ...o });
  assert.equal(guide({ condition: 'sealed', mfgDate: '2026-07-26' }).suggested, 383);   // 450 x 0.85 x 1.00
  assert.equal(guide({ condition: 'opened', mfgDate: '2026-07-26' }).suggested, 315);   // 450 x 0.70
  assert.equal(guide({ condition: 'opened', visual: 'clumped', mfgDate: '2026-07-26' }).suggested, 225); // 450 x 0.50
  assert.equal(guide({ condition: 'sealed', mfgDate: '2026-01-26' }).suggested, 344);   // 8 months: x 0.90
  assert.equal(guide({ condition: 'sealed', mfgDate: '2025-01-26' }).suggested, 287);   // over 12 months: x 0.75
  assert.equal(guide({ condition: 'partially_used' }).suggested, 315);
  const g = guide({ condition: 'sealed' });
  assert.equal(g.min, 180);
  assert.equal(g.max, 405);
  assert.equal(resale.priceGuide({ catalogPrice: 450, condition: 'opened', visual: 'separated', mfgDate: '2024-01-01', today }).suggested, 180 + 0 || 0, 'never below the 40% floor');
});

test('commission: verified 8% + 3% leaves 89%; unverified 10% + 4% leaves 86%; cash keeps 97% of that', () => {
  assert.deepEqual(resale.commission({ gross: 1000, verified: true, payoutMode: 'wallet' }), { platformPct: 8, operatorPct: 3, platformFee: 80, operatorCut: 30, share: 890, sellerNet: 890 });
  assert.equal(resale.commission({ gross: 1000, verified: false, payoutMode: 'upi' }).sellerNet, 860);
  assert.equal(resale.commission({ gross: 1000, verified: true, payoutMode: 'cash' }).sellerNet, 863.3);
  assert.equal(resale.commission({ gross: 1000, verified: false, payoutMode: 'cash' }).sellerNet, 834.2);
});

test('the smallest listing is 2 kg, or 1 litre for a liquid', () => {
  assert.equal(resale.minimumUnits({ unit_label: '40 kg bag', weight_kg: 40 }), 1);
  assert.equal(resale.minimumUnits({ unit_label: '0.5 kg pack', weight_kg: 0.5 }), 4);
  assert.equal(resale.minimumUnits({ unit_label: '1 L bottle', weight_kg: 1 }), 1);
  assert.equal(resale.minimumUnits({ unit_label: '0.25 L bottle', weight_kg: 0.25 }), 4);
});

test('a farmer\'s resale is shown to its own area first and to neighbouring centers after a week', () => {
  const lot = (days) => ({ isFarmerResale: true, createdAt: new Date(Date.now() - days * 86400000).toISOString() });
  assert.equal(resale.visibleFrom(lot(1), 4), true);
  assert.equal(resale.visibleFrom(lot(1), 25), false);
  assert.equal(resale.visibleFrom(lot(8), 25), true);
  assert.equal(resale.visibleFrom({ isFarmerResale: false, createdAt: new Date().toISOString() }, 30), true, 'a center\'s own surplus is not limited');
});

// ---- listing --------------------------------------------------------------------------------------

test('only what the farmer bought, collected and is organic can be listed, with the amount left', async () => {
  const c = await makeCenter('elig');
  const farmer = 'elig-farmer';
  assert.deepEqual((await call('GET', '/v1/resale/eligible', { device: farmer })).json, []);
  await call('POST', '/v1/operator/inventory/receive', { device: c.device, body: { productId: 'p-biopesticide', quantity: 10 } });
  await buyAndCollect(c, farmer, 5);
  await buyAndCollect(c, farmer, 1, 'p-biopesticide'); // a pesticide: never resellable
  // Reserved but not collected does not count.
  await call('POST', '/v1/orders', { device: farmer, body: { centerId: c.centerId, items: [{ productId: 'p-neemcake', quantity: 3 }] } });
  const eligible = (await call('GET', '/v1/resale/eligible', { device: farmer })).json;
  assert.deepEqual(eligible.map((e) => [e.productId, e.purchased, e.remaining, e.listingsLeft]), [['p-vermicompost', 5, 5, 3]]);
});

test('the suggestion endpoint returns the price and the allowed range', async () => {
  const r = await call('POST', '/v1/resale/suggest', { body: { productId: 'p-vermicompost', condition: 'opened', mfgDate: daysFromNow(-30) } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.suggested, r.json.min, r.json.max], [315, 180, 405]);
  assert.equal((await call('POST', '/v1/resale/suggest', { body: { productId: 'p-biopesticide', condition: 'sealed' } })).status, 409, 'not organic');
});

test('a draft is refused for the reasons in the rules', async () => {
  const c = await makeCenter('rules');
  const farmer = 'rules-farmer';
  await buyAndCollect(c, farmer, 3);
  const post = (over) => call('POST', '/v1/resale', { device: farmer, body: listing(c, over) });

  assert.equal((await post({ askingPrice: 100 })).status, 400, 'below 40%');
  assert.match((await post({ askingPrice: 420 })).json.error, /between Rs 180 and Rs 405/);
  assert.equal((await post({ expiryDate: daysFromNow(-1) })).status, 409, 'expired');
  assert.equal((await post({ expiryDate: daysFromNow(0) })).status, 409, 'expires today');
  assert.equal((await post({ mfgDate: daysFromNow(3) })).status, 400, 'made in the future');
  assert.equal((await post({ mfgDate: daysFromNow(-10), expiryDate: daysFromNow(-20) })).status, 409);
  assert.equal((await post({ productId: 'p-neemcake' })).status, 409, 'never bought (only reserved, or not at all)');
  assert.equal((await post({ productId: 'p-biopesticide' })).status, 409, 'not organic');
  assert.match((await post({ units: 4 })).json.error, /at most 3/);
  assert.equal((await post({ payoutMode: 'upi' })).status, 400, 'UPI needs an id');
  assert.equal((await post({ payoutMode: 'upi', upiId: 'not-an-upi' })).status, 400);
  assert.equal((await post({ payoutMode: 'upi', upiId: 'asha@okbank' })).status, 201);
  assert.equal((await post({ centerId: 'nope' })).status, 404);
  assert.equal((await call('POST', '/v1/resale', { device: 'never-bought', body: listing(c) })).status, 409);
  const ok = await post({ units: 1 });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.status, 'draft');
  assert.equal(ok.json.suggestedPrice, 383);
  assert.equal(ok.json.verifiedPurchase, true, 'a platform order backs it');
  assert.equal(ok.json.youReceive, undefined);
});

test('the same product cannot be listed more than three times in a season, withdrawn ones included', async () => {
  const c = await makeCenter('season');
  const farmer = 'season-farmer';
  await buyAndCollect(c, farmer, 5);
  for (let i = 0; i < 3; i += 1) {
    const r = await call('POST', '/v1/resale', { device: farmer, body: listing(c, { units: 1 }) });
    assert.equal(r.status, 201, r.text);
    if (i === 0) assert.equal((await call('POST', `/v1/resale/${r.json.id}/withdraw`, { device: farmer })).status, 200);
  }
  const fourth = await call('POST', '/v1/resale', { device: farmer, body: listing(c, { units: 1 }) });
  assert.equal(fourth.status, 409);
  assert.match(fourth.json.error, /3 times this season/);
  const eligible = (await call('GET', '/v1/resale/eligible', { device: farmer })).json[0];
  assert.equal(eligible.listingsLeft, 0);
});

test('both photos are needed before it can be sent, and they must be real images', async () => {
  const c = await makeCenter('photo');
  const farmer = 'photo-farmer';
  await buyAndCollect(c, farmer, 2);
  const draft = (await call('POST', '/v1/resale', { device: farmer, body: listing(c, { units: 1 }) })).json;
  assert.equal((await call('POST', `/v1/resale/${draft.id}/submit`, { device: farmer })).status, 409);
  assert.equal((await upload(farmer, draft.id, 'front', await testImage())).status, 201);
  assert.equal((await call('POST', `/v1/resale/${draft.id}/submit`, { device: farmer })).status, 409, 'one photo is not enough');
  assert.equal((await upload(farmer, draft.id, 'back', Buffer.from('not an image'))).status, 422);
  assert.equal((await upload('someone-else', draft.id, 'back', await testImage())).status, 404, 'not their listing');
  assert.equal((await upload(farmer, draft.id, 'side', await testImage())).status, 404);
  assert.equal((await upload(farmer, draft.id, 'back', await testImage())).status, 201);
  const sent = await call('POST', `/v1/resale/${draft.id}/submit`, { device: farmer });
  assert.equal(sent.json.status, 'pending_verification');
  assert.equal(sent.json.photoCount, 2);
  const photo = await fetch(`${base}/v1/resale/${draft.id}/photos/front`, { headers: { 'x-device-id': farmer } });
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${base}/v1/resale/${draft.id}/photos/front`, { headers: { 'x-device-id': 'x' } })).status, 404);
});

// ---- digital listing, end to end -------------------------------------------------------------------

test('remote pre-approval puts it live; a buyer starts the 48-hour clock; inspection lets it be collected; the seller is paid', async () => {
  const c = await makeCenter('flow');
  const seller = 'flow-seller';
  await buyAndCollect(c, seller, 5);
  const sent = await submitListing(c, seller, { units: 2 });

  // The operator sees it in the queue and can look at the photos.
  const queue = (await call('GET', '/v1/operator/resale', { device: c.device })).json;
  assert.deepEqual(queue.map((l) => l.id), [sent.id]);
  assert.equal(queue[0].sellerDisplayName, 'Farmer');
  assert.equal((await fetch(`${base}/v1/operator/resale/${sent.id}/photos/front`, { headers: { 'x-device-id': c.device } })).status, 200);
  assert.equal((await call('GET', '/v1/operator/resale', { device: 'op-of-another-center' })).status, 403);
  const otherCenter = await makeCenter('other');
  assert.deepEqual((await call('GET', '/v1/operator/resale', { device: otherCenter.device })).json, [], 'another center sees nothing');
  assert.equal((await call('POST', `/v1/operator/resale/${sent.id}/preapprove`, { device: otherCenter.device })).status, 404);

  const live = await call('POST', `/v1/operator/resale/${sent.id}/preapprove`, { device: c.device });
  assert.equal(live.status, 200, live.text);
  assert.equal(live.json.status, 'live');
  assert.equal(live.json.unitsAvailable, 2);
  assert.ok((await call('GET', '/v1/farmer/notifications', { device: seller })).json.some((n) => n.title === 'Your listing is live'));

  // It is on the marketplace, marked as a farmer's, not yet inspected, backed by a real purchase.
  const lots = await surplusNear(c);
  const lot = lots.find((l) => l.id === live.json.lotId);
  assert.equal(lot.isFarmerResale, true);
  assert.equal(lot.inspected, false);
  assert.equal(lot.verifiedPurchase, true);
  assert.equal(lot.unitPrice, 380);
  assert.equal(lot.discountPercent, 16);

  // A buyer orders one bag. The seller now has 48 hours; nobody can collect it yet.
  const order = await buy(lot.id, 'flow-buyer', 1, c.centerId);
  const afterBuy = (await call('GET', `/v1/resale/${sent.id}`, { device: seller })).json;
  assert.equal(afterBuy.status, 'awaiting_handover');
  const hours = (new Date(afterBuy.handoverDue).getTime() - Date.now()) / 3600000;
  assert.ok(hours > 47 && hours <= 48, `due in about 48 hours, got ${hours}`);
  const alert = (await call('GET', '/v1/farmer/notifications', { device: seller })).json.find((n) => n.title === 'Your fertilizer has a buyer');
  assert.match(alert.body, /within 48 hours/);
  const blocked = await call('POST', `/v1/operator/orders/${order.id}/ready`, { device: c.device });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /not brought this in yet/);

  // The seller brings it; the operator inspects. Cannot raise the price, cannot accept more than listed or fewer than reserved.
  const inspect = (body) => call('POST', `/v1/operator/resale/${sent.id}/inspect`, { device: c.device, body });
  assert.equal((await inspect(checklist({ units: 3 }))).status, 409, 'a listing cannot grow');
  assert.equal((await inspect(checklist({ unitPrice: 400 }))).status, 400, 'the price cannot go up');
  const accepted = await inspect(checklist());
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.json.status, 'listed');
  assert.equal(accepted.json.unitsAvailable, 1);
  assert.equal(accepted.json.unitsReserved, 1);
  assert.equal(accepted.json.batchNumber, 'B-2201');
  assert.equal(accepted.json.finalPrice, 380);
  const lotNow = (await surplusNear(c)).find((l) => l.id === live.json.lotId);
  assert.equal(lotNow.inspected, true);

  // Now the buyer can collect. The seller is paid 89% of 380 into the wallet, instantly.
  const done = await collect(c, order);
  assert.equal(done.status, 200, done.text);
  const w = await wallet(seller);
  assert.equal(w.balance, 338.2);
  assert.deepEqual(w.entries.map((e) => [e.kind, e.amount]), [['resale_earning', 338.2]]);
  const sale = (await call('GET', `/v1/resale/${sent.id}`, { device: seller })).json;
  assert.equal(sale.unitsSold, 1);
  assert.deepEqual([sale.sales[0].gross, sale.sales[0].platformFee, sale.sales[0].operatorCut, sale.sales[0].sellerNet], [380, 30.4, 11.4, 338.2]);
  assert.equal(sale.sales[0].verified, true);
  assert.equal(sale.sales[0].payoutStatus, 'paid');
  assert.ok((await call('GET', '/v1/farmer/notifications', { device: seller })).json.some((n) => n.title === 'Your fertilizer sold'));

  // The second bag sells too; the listing is then sold out and leaves the marketplace.
  const second = await buy(live.json.lotId, 'flow-buyer-2', 1, c.centerId);
  assert.equal((await collect(c, second)).status, 200);
  assert.equal((await call('GET', `/v1/resale/${sent.id}`, { device: seller })).json.status, 'sold_out');
  assert.equal((await wallet(seller)).balance, 676.4);
  assert.equal((await surplusNear(c)).find((l) => l.id === live.json.lotId), undefined);
});

test('the operator can ask for the goods first, and the listing only goes live after inspection', async () => {
  const c = await makeCenter('inspectfirst');
  const seller = 'if-seller';
  await buyAndCollect(c, seller, 2);
  const sent = await submitListing(c, seller, { units: 1 });
  const asked = await call('POST', `/v1/operator/resale/${sent.id}/request-inspection`, { device: c.device, body: { note: 'First sale, so please bring it.' } });
  assert.equal(asked.json.status, 'inspection_required');
  assert.match((await call('GET', '/v1/farmer/notifications', { device: seller })).json.find((n) => n.title === 'Please bring it to the center').body, /First sale/);
  assert.equal((await surplusNear(c)).filter((l) => l.isFarmerResale).length, 0, 'not on sale yet');

  const listed = await call('POST', `/v1/operator/resale/${sent.id}/inspect`, { device: c.device, body: checklist({ units: 1 }) });
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.status, 'listed');
  const lot = (await surplusNear(c)).find((l) => l.isFarmerResale);
  assert.equal(lot.inspected, true);
  assert.equal(lot.available, 1);
});

test('the counter check hard-stops expired, damaged, spoiled, unidentifiable and unlabelled goods', async () => {
  const c = await makeCenter('blocks');
  const seller = 'blocks-seller';
  await buyAndCollect(c, seller, 3);
  const sent = await submitListing(c, seller, { units: 1 });
  const inspect = (over) => call('POST', `/v1/operator/resale/${sent.id}/inspect`, { device: c.device, body: checklist({ units: 1, ...over }) });
  const blocked = async (over, pattern) => {
    const r = await inspect(over);
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error, pattern);
    assert.ok(r.json.blocks.length >= 1);
  };
  await blocked({ expiryDate: daysFromNow(-2) }, /expired/);
  await blocked({ seal: 'damaged_packaging' }, /severely damaged/);
  await blocked({ visual: 'wet' }, /wet or spoiled/);
  await blocked({ productMatches: false }, /cannot be matched/);
  await blocked({ batchNumber: '' }, /batch number/);
  const several = await inspect({ expiryDate: daysFromNow(-2), visual: 'wet', batchNumber: '' });
  assert.equal(several.json.blocks.length, 3);
  assert.equal((await call('GET', `/v1/operator/resale/${sent.id}`, { device: c.device })).json.status, 'pending_verification', 'nothing changed');
});

test('a worse condition than described lowers the price automatically, within the allowed range', async () => {
  const c = await makeCenter('worse');
  const seller = 'worse-seller';
  await buyAndCollect(c, seller, 2);
  const sent = await submitListing(c, seller, { units: 1, askingPrice: 380 });
  const r = await call('POST', `/v1/operator/resale/${sent.id}/inspect`, { device: c.device, body: checklist({ units: 1, seal: 'opened_resealed', visual: 'clumped' }) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.finalPrice, 225, 'clumped: 450 x 50%');
  assert.equal(r.json.condition, 'opened');
  assert.match((await call('GET', '/v1/farmer/notifications', { device: seller })).json.find((n) => n.title === 'Your goods were accepted').body, /lowered from Rs 380/);
  const lot = (await surplusNear(c)).find((l) => l.isFarmerResale);
  assert.equal(lot.unitPrice, 225);
});

test('rejecting at the counter cancels the buyer\'s order and tells them', async () => {
  const c = await makeCenter('reject');
  const seller = 'rej-seller';
  await buyAndCollect(c, seller, 2);
  const sent = await submitListing(c, seller, { units: 1 });
  const live = (await call('POST', `/v1/operator/resale/${sent.id}/preapprove`, { device: c.device })).json;
  const order = await buy(live.lotId, 'rej-buyer', 1, c.centerId);
  assert.equal((await call('POST', `/v1/operator/resale/${sent.id}/reject`, { device: c.device, body: {} })).status, 400, 'a reason is required');
  const rejected = await call('POST', `/v1/operator/resale/${sent.id}/reject`, { device: c.device, body: { reason: 'the bag is torn and the batch number is scratched off' } });
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(rejected.json.status, 'rejected');
  assert.equal(rejected.json.buyerOrdersCancelled, 1);
  assert.equal((await call('GET', `/v1/orders/${order.id}`, { device: 'rej-buyer' })).json.status, 'cancelled');
  assert.ok((await call('GET', '/v1/farmer/notifications', { device: 'rej-buyer' })).json.some((n) => n.title === 'Your order was cancelled'));
  assert.ok((await call('GET', '/v1/farmer/notifications', { device: seller })).json.some((n) => n.title === 'Your listing was not accepted'));
  assert.equal((await surplusNear(c)).filter((l) => l.isFarmerResale).length, 0);
  assert.equal((await call('POST', `/v1/operator/resale/${sent.id}/reject`, { device: c.device, body: { reason: 'again' } })).status, 409);
});

test('a seller who does not come within 48 hours loses the listing and the buyer is cancelled', async () => {
  const c = await makeCenter('late');
  const seller = 'late-seller';
  await buyAndCollect(c, seller, 2);
  const sent = await submitListing(c, seller, { units: 1 });
  const live = (await call('POST', `/v1/operator/resale/${sent.id}/preapprove`, { device: c.device })).json;
  const order = await buy(live.lotId, 'late-buyer', 1, c.centerId);
  assert.deepEqual(await resale.runMaintenance(db, new Date(Date.now() + 47 * 3600000)), { expired: 0 });
  assert.deepEqual(await resale.runMaintenance(db, new Date(Date.now() + 49 * 3600000)), { expired: 1 });
  assert.equal((await call('GET', `/v1/resale/${sent.id}`, { device: seller })).json.status, 'rejected');
  assert.equal((await call('GET', `/v1/orders/${order.id}`, { device: 'late-buyer' })).json.status, 'cancelled');
  assert.deepEqual(await resale.runMaintenance(db, new Date(Date.now() + 50 * 3600000)), { expired: 0 });
});

test('a seller can take an unsold listing back, but not one a buyer has reserved', async () => {
  const c = await makeCenter('withdraw');
  const seller = 'wd-seller';
  await buyAndCollect(c, seller, 3);
  const a = await submitListing(c, seller, { units: 1 });
  const live = (await call('POST', `/v1/operator/resale/${a.id}/preapprove`, { device: c.device })).json;
  const order = await buy(live.lotId, 'wd-buyer', 1, c.centerId);
  const refused = await call('POST', `/v1/resale/${a.id}/withdraw`, { device: seller });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /already reserved/);
  await call('POST', `/v1/orders/${order.id}/cancel`, { device: 'wd-buyer' });
  assert.equal((await call('POST', `/v1/resale/${a.id}/withdraw`, { device: seller })).json.status, 'withdrawn');
  assert.equal((await surplusNear(c)).filter((l) => l.isFarmerResale).length, 0);
  assert.equal((await call('POST', `/v1/resale/${a.id}/withdraw`, { device: seller })).status, 409);
  assert.equal((await call('POST', `/v1/resale/${a.id}/withdraw`, { device: 'someone' })).status, 404);
});

// ---- selling at the counter -----------------------------------------------------------------------

test('a registered farmer selling at the counter is verified by their purchases and can choose how to be paid', async () => {
  const c = await makeCenter('walkin');
  const seller = 'walk-seller';
  await call('PUT', '/v1/farmer/profile', { device: seller, body: { name: 'Sunita Jadhav', village: 'Shirur' } });
  await call('PUT', '/v1/farmer/contact', { device: seller, body: { phone: '9822011111' } });
  await buyAndCollect(c, seller, 4);

  const found = (await call('GET', '/v1/operator/resale/sellers?q=sunita', { device: c.device })).json;
  assert.deepEqual(found.map((f) => [f.sellerId, f.name]), [[seller, 'Sunita Jadhav']]);
  assert.equal((await call('GET', '/v1/operator/resale/sellers?q=9822011', { device: c.device })).json.length, 1, 'by phone too');

  const r = await call('POST', '/v1/operator/resale/walk-in', { device: c.device, body: { sellerId: seller, productId: 'p-vermicompost', payoutMode: 'upi', ...checklist({ units: 2, upiId: 'sunita@okbank' }) } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.status, 'listed');
  assert.equal(r.json.channel, 'walk_in');
  assert.equal(r.json.verifiedPurchase, true);
  assert.equal(r.json.finalPrice, 383, 'no price given: the suggested one');
  const lot = (await surplusNear(c)).find((l) => l.id === r.json.lotId);
  assert.equal(lot.inspected, true);

  // Sold: 89% is queued for UPI, not credited to the wallet.
  const order = await buy(lot.id, 'walk-buyer', 1, c.centerId);
  assert.equal((await collect(c, order)).status, 200);
  assert.equal((await wallet(seller)).balance, 0);
  const pending = (await call('GET', '/v1/admin/resale/payouts/upi', { device: 'admin' })).json;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].upiId, 'sunita@okbank');
  assert.equal(pending[0].amount, 340.87);
  assert.equal((await call('GET', '/v1/admin/overview', { device: 'admin' })).json.resale.upiPending, 1);
  const paid = await call('POST', `/v1/admin/resale/payouts/${pending[0].saleId}/paid`, { device: 'admin', body: { reference: 'UTR123' } });
  assert.equal(paid.status, 200);
  assert.equal((await call('POST', `/v1/admin/resale/payouts/${pending[0].saleId}/paid`, { device: 'admin', body: {} })).status, 409);
  assert.ok((await call('GET', '/v1/farmer/notifications', { device: seller })).json.some((n) => n.title === 'UPI payout sent'));
  assert.equal((await call('GET', '/v1/admin/resale/payouts/upi', { device: 'admin' })).json.length, 0);
});

test('a seller with no account is paid in cash, is never verified, and the center hands the cash over', async () => {
  const c = await makeCenter('cash');
  const post = (over) => call('POST', '/v1/operator/resale/walk-in', { device: c.device, body: { productId: 'p-vermicompost', ...checklist({ units: 2 }), ...over } });
  assert.equal((await post({})).status, 400, 'a name and phone are needed');
  assert.equal((await post({ sellerName: 'Bapu Shinde', sellerPhone: '9822000000', payoutMode: 'wallet' })).status, 400, 'cash only');
  const r = await post({ sellerName: 'Bapu Shinde', sellerPhone: '9822000000' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.payoutMode, 'cash');
  assert.equal(r.json.verifiedPurchase, false);
  assert.equal(r.json.sellerName, 'Bapu Shinde');

  const order = await buy(r.json.lotId, 'cash-buyer', 2, c.centerId);
  assert.equal((await collect(c, order)).status, 200);
  const due = (await call('GET', '/v1/operator/resale/payouts/cash', { device: c.device })).json;
  assert.equal(due.length, 1);
  assert.equal(due[0].sellerName, 'Bapu Shinde');
  assert.equal(due[0].amount, 639, '766 x 86% x 97%');
  assert.equal((await call('POST', `/v1/operator/resale/payouts/${due[0].saleId}/cash-paid`, { device: 'op-not-mine' })).status, 403);
  const paid = await call('POST', `/v1/operator/resale/payouts/${due[0].saleId}/cash-paid`, { device: c.device });
  assert.equal(paid.status, 200);
  assert.equal((await call('POST', `/v1/operator/resale/payouts/${due[0].saleId}/cash-paid`, { device: c.device })).status, 409);
  assert.deepEqual((await call('GET', '/v1/operator/resale/payouts/cash', { device: c.device })).json, []);
});

test('the counter also refuses non-organic products, and a farmer who used up their three listings', async () => {
  const c = await makeCenter('counter');
  const seller = 'counter-seller';
  await buyAndCollect(c, seller, 6);
  const walk = (over) => call('POST', '/v1/operator/resale/walk-in', { device: c.device, body: { sellerId: seller, productId: 'p-vermicompost', payoutMode: 'wallet', ...checklist({ units: 1 }), ...over } });
  assert.equal((await walk({ productId: 'p-biopesticide' })).status, 409);
  for (let i = 0; i < 3; i += 1) assert.equal((await walk({})).status, 201);
  const fourth = await walk({});
  assert.equal(fourth.status, 409);
  assert.match(fourth.json.error, /3 times this season/);
});

// ---- complaints -----------------------------------------------------------------------------------

test('a buyer can complain within 48 hours; an upheld complaint refunds them, docks the seller, and costs the center points', async () => {
  const c = await makeCenter('dispute');
  const seller = 'disp-seller';
  await buyAndCollect(c, seller, 3);
  const sent = await submitListing(c, seller, { units: 2 });
  const live = (await call('POST', `/v1/operator/resale/${sent.id}/preapprove`, { device: c.device })).json;
  const order = await buy(live.lotId, 'disp-buyer', 1, c.centerId);
  await call('POST', `/v1/operator/resale/${sent.id}/inspect`, { device: c.device, body: checklist() });
  assert.equal((await collect(c, order)).status, 200);
  assert.equal((await wallet(seller)).balance, 338.2);

  assert.equal((await call('POST', '/v1/resale/disputes', { device: 'stranger', body: { orderId: order.id, reason: 'It was damp' } })).status, 404, 'only the buyer');
  assert.equal((await call('POST', '/v1/resale/disputes', { device: 'disp-buyer', body: { orderId: order.id, reason: 'no' } })).status, 400, 'a reason is needed');
  const raised = await call('POST', '/v1/resale/disputes', { device: 'disp-buyer', body: { orderId: order.id, reason: 'The fertilizer was damp and clumped' } });
  assert.equal(raised.status, 201, raised.text);
  assert.equal((await call('POST', '/v1/resale/disputes', { device: 'disp-buyer', body: { orderId: order.id, reason: 'again please' } })).status, 409, 'once per purchase');

  const open = (await call('GET', '/v1/admin/resale/disputes?status=open', { device: 'admin' })).json;
  assert.equal(open.length >= 1, true);
  const mine = open.find((d) => d.disputeId === raised.json.disputeId);
  assert.equal(mine.gross, 380);
  assert.equal(mine.inspection.batchNumber, 'B-2201', 'the admin sees the inspection record');
  assert.equal(mine.centerQuality, 100);

  assert.equal((await call('POST', `/v1/admin/resale/disputes/${mine.disputeId}/resolve`, { device: 'admin', body: { decision: 'uphold' } })).status, 400, 'a refund percentage is needed');
  const upheld = await call('POST', `/v1/admin/resale/disputes/${mine.disputeId}/resolve`, { device: 'admin', body: { decision: 'uphold', refundPercent: 50, note: 'Partly damp' } });
  assert.equal(upheld.status, 200, upheld.text);
  assert.equal(upheld.json.refundAmount, 190);
  assert.equal((await wallet('disp-buyer')).balance, 190);
  assert.equal((await wallet(seller)).balance, 169.1, 'the seller bears half of their 338.20');
  assert.equal((await db.query('SELECT resale_quality FROM village_center WHERE center_id = $1', [c.centerId])).rows[0].resale_quality, 95);
  assert.equal((await call('POST', `/v1/admin/resale/disputes/${mine.disputeId}/resolve`, { device: 'admin', body: { decision: 'reject' } })).status, 409, 'decided once');
});

test('a rejected complaint changes no money, and one after 48 hours is too late', async () => {
  const c = await makeCenter('dispute2');
  const seller = 'disp2-seller';
  await buyAndCollect(c, seller, 3);
  const sent = await submitListing(c, seller, { units: 2 });
  const live = (await call('POST', `/v1/operator/resale/${sent.id}/preapprove`, { device: c.device })).json;
  const late = await buy(live.lotId, 'late-complainer', 1, c.centerId);
  await call('POST', `/v1/operator/resale/${sent.id}/inspect`, { device: c.device, body: checklist() });
  assert.equal((await collect(c, late)).status, 200);
  const other = await buy(live.lotId, 'fair-complainer', 1, c.centerId);
  assert.equal((await collect(c, other)).status, 200);

  await db.query("UPDATE resale_sale SET created_at = now() - interval '49 hours' WHERE order_id = $1", [late.id]);
  const tooLate = await call('POST', '/v1/resale/disputes', { device: 'late-complainer', body: { orderId: late.id, reason: 'I noticed it a few days later' } });
  assert.equal(tooLate.status, 409);
  assert.match(tooLate.json.error, /within 48 hours/);

  const raised = await call('POST', '/v1/resale/disputes', { device: 'fair-complainer', body: { orderId: other.id, reason: 'I do not like the colour' } });
  const before = (await wallet(seller)).balance;
  const r = await call('POST', `/v1/admin/resale/disputes/${raised.json.disputeId}/resolve`, { device: 'admin', body: { decision: 'reject', note: 'It matched the listing' } });
  assert.deepEqual(r.json, { disputeId: raised.json.disputeId, status: 'rejected' });
  assert.equal((await wallet('fair-complainer')).balance, 0);
  assert.equal((await wallet(seller)).balance, before);
});

// ---- the wallet -----------------------------------------------------------------------------------

test('wallet money pays an order all at once, and comes back if the order is cancelled', async () => {
  const c = await makeCenter('wallet');
  const farmer = 'wallet-farmer';
  await db.query("INSERT INTO farmer_wallet_entry (entry_id, owner_id, amount, kind) VALUES ('w1', $1, 700, 'adjustment')", [farmer]);
  const order = (await call('POST', '/v1/orders', { device: farmer, body: { centerId: c.centerId, items: [{ productId: 'p-vermicompost', quantity: 2 }] } })).json;
  assert.equal(order.totalAmount, 900);
  const short = await call('POST', '/v1/payments/wallet', { device: farmer, body: { orderId: order.id } });
  assert.equal(short.status, 409);
  assert.match(short.json.error, /wallet has Rs 700, this order needs Rs 900/);
  assert.equal((await wallet(farmer)).balance, 700, 'nothing was taken');

  const small = (await call('POST', '/v1/orders', { device: farmer, body: { centerId: c.centerId, items: [{ productId: 'p-vermicompost', quantity: 1 }] } })).json;
  const paid = await call('POST', '/v1/payments/wallet', { device: farmer, body: { orderId: small.id } });
  assert.equal(paid.status, 200, paid.text);
  assert.deepEqual(paid.json, { orderId: small.id, paid: 450, balance: 250 });
  assert.equal((await call('GET', `/v1/orders/${small.id}`, { device: farmer })).json.paymentStatus, 'paid');
  assert.equal((await call('POST', '/v1/payments/wallet', { device: farmer, body: { orderId: small.id } })).status, 409, 'paid once');
  assert.equal((await call('POST', '/v1/payments/wallet', { device: 'someone-else', body: { orderId: order.id } })).status, 404);

  assert.equal((await call('POST', `/v1/orders/${small.id}/cancel`, { device: farmer })).status, 200);
  assert.equal((await wallet(farmer)).balance, 700, 'refunded to the wallet straight away');
  assert.equal((await call('GET', `/v1/orders/${small.id}`, { device: farmer })).json.paymentStatus, 'refunded');
  assert.deepEqual((await wallet(farmer)).entries.map((e) => e.kind).sort(), ['adjustment', 'order_payment', 'order_refund']);
});
