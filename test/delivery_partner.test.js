process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');

// Farmers who apply to deliver, and the village center's operator (or an admin)
// who checks their papers (anonymous X-Device-Id mode).
const { weightFromLabel } = require('../src/utils/weight');
const dp = require('../src/services/deliveryPartner');

let server;
let base;
let db;
let counter = 0;
let testImage;

const call = async (method, path, { body, device = 'farmer-1' } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-device-id': device },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};
const errorText = (res) => res.json?.error?.message ?? res.json?.error ?? '';

const upload = async (device, kind, buffer, type = 'image/jpeg') => {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), 'papers');
  const res = await fetch(`${base}/v1/delivery/partner/documents/${kind}`, { method: 'POST', headers: { 'x-device-id': device }, body: form });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

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

let plate = 1000;
const newPlate = () => `MH12AB${(plate += 1)}`;
const details = (extra = {}) => ({ vehicleType: 'pickup', vehicleNumber: newPlate(), capacityKg: 600, phone: '98765 43210', ...extra });
const save = (device, body) => call('PUT', '/v1/delivery/partner', { device, body });
const mine = async (device) => (await call('GET', '/v1/delivery/partner', { device })).json;
const alerts = async (device) => (await call('GET', '/v1/farmer/notifications', { device })).json.filter((n) => n.type === 'delivery');

// A farmer with everything filled in, ready to submit to `center`.
const readyFarmer = async (name, center, extra = {}) => {
  const device = `partner-${name}-${counter += 1}`;
  await call('PUT', '/v1/farmer/profile', { device, body: { name: `Farmer ${name}`, village: 'Shirur' } });
  assert.equal((await save(device, details({ reviewCenterId: center.centerId, ...extra }))).status, 200);
  assert.equal((await upload(device, 'licence', await testImage())).status, 201);
  assert.equal((await upload(device, 'rc', await testImage([200, 100, 50], 'png'), 'image/png')).status, 201);
  return device;
};
const submitted = async (name, center, extra) => {
  const device = await readyFarmer(name, center, extra);
  const res = await call('POST', '/v1/delivery/partner/submit', { device });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return device;
};
const act = (operatorOrAdmin, userId, action, note, prefix = 'operator') =>
  call('POST', `/v1/${prefix}/delivery-partners/${userId}/${action}`, { device: operatorOrAdmin, body: note === undefined ? {} : { note } });

test.before(async () => {
  const { openTestDb, testImage: image } = require('./helpers');
  const { createApp } = require('../src/app');
  testImage = image;
  db = await openTestDb('t_delivery_partner');
  const app = createApp(db);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

// ---------------------------------------------------------------------------
// The rules, on their own
// ---------------------------------------------------------------------------

test('a product weighs what its label says', () => {
  assert.equal(weightFromLabel('40 kg bag', 'organic'), 40);
  assert.equal(weightFromLabel('2.5kg pack', 'organic'), 2.5);
  assert.equal(weightFromLabel('per kg', 'seed'), 1);
  assert.equal(weightFromLabel('1 L bottle', 'pesticide'), 1);
  assert.equal(weightFromLabel('5 litre can', 'pesticide'), 5);
  assert.equal(weightFromLabel('per unit', 'equipment'), 5, 'equipment with no weight in its label');
  assert.equal(weightFromLabel('per unit', 'seed'), 1);
  assert.equal(weightFromLabel('', 'organic'), 1);
});

test('the catalog carries weights, so deliveries can be matched to a vehicle', async () => {
  const list = (await call('GET', '/v1/products?limit=200')).json;
  const byId = Object.fromEntries(list.map((p) => [p.id, p.weightKg]));
  assert.equal(Number(byId['p-vermicompost']), 40);
  assert.equal(Number(byId['p-neemcake']), 25);
  assert.ok(list.every((p) => Number(p.weightKg) > 0));
});

test('vehicle numbers are tidied and must look like a plate', () => {
  assert.equal(dp.normalizeVehicleNumber('mh 12 ab 3456'), 'MH12AB3456');
  assert.equal(dp.normalizeVehicleNumber('MH-12-AB-3456'), 'MH12AB3456');
  for (const bad of ['', 'abc', '123456', 'ABCDEF', 'MH12AB3456789012', 'MH12 AB!456']) {
    assert.throws(() => dp.normalizeVehicleNumber(bad), /registration number/, bad);
  }
});

test('phone numbers are Indian mobiles, with or without the country code', () => {
  for (const ok of ['9876543210', '+91 98765 43210', '098765-43210', '91 9876543210', '(987) 654-3210']) {
    assert.equal(dp.normalizePhone(ok), '9876543210', ok);
  }
  for (const bad of ['', '12345', '5876543210', '98765432101', 'call me']) assert.throws(() => dp.normalizePhone(bad), /10-digit/, bad);
});

test('a vehicle can only claim what it could carry', () => {
  assert.doesNotThrow(() => dp.checkCapacity('bike', 40));
  assert.throws(() => dp.checkCapacity('bike', 2000), /bike can carry 5 to 80 kg/);
  assert.throws(() => dp.checkCapacity('pickup', 50), /100 to 1500/);
  assert.doesNotThrow(() => dp.checkCapacity('tractor', 3000));
  assert.throws(() => dp.checkCapacity('tractor', 20000), /500 to 8000/);
});

test('days round-trip through the bitmask', () => {
  assert.deepEqual(dp.daysFromMask(dp.maskFromDays([0, 2, 6])), [0, 2, 6]);
  assert.equal(dp.maskFromDays([0, 1, 2, 3, 4, 5, 6]), 127);
  assert.deepEqual(dp.daysFromMask(1), [0]);
});

test('free now needs approval, the switch, a working day and the hours, judged on the center clock', () => {
  const monday10am = new Date('2026-09-21T04:30:00Z'); // Monday 10:00 in India
  const p = (o = {}) => ({ status: 'approved', online: true, daysMask: dp.maskFromDays([0, 1, 2, 3, 4]), freeFrom: '08:00', freeUntil: '18:00', ...o });
  const tz = 'Asia/Kolkata';
  assert.deepEqual(dp.availabilityAt(p(), monday10am, tz), { free: true, reason: '' });
  assert.equal(dp.availabilityAt(p({ status: 'pending' }), monday10am, tz).free, false);
  assert.equal(dp.availabilityAt(p({ online: false }), monday10am, tz).reason, 'switched off');
  assert.equal(dp.availabilityAt(p({ daysMask: dp.maskFromDays([5, 6]) }), monday10am, tz).reason, 'not one of his days');
  assert.equal(dp.availabilityAt(p({ freeFrom: '11:00' }), monday10am, tz).reason, 'outside his hours');
  assert.equal(dp.availabilityAt(p({ freeUntil: '10:00' }), monday10am, tz).free, false, 'the end of his hours is exclusive');
  // The same instant is Sunday 23:30 in New York, which is not one of his days.
  assert.equal(dp.availabilityAt(p(), monday10am, 'America/New_York').free, false);
});

// ---------------------------------------------------------------------------
// Becoming a partner
// ---------------------------------------------------------------------------

test('a farmer who never applied sees where to start', async () => {
  const res = await call('GET', '/v1/delivery/partner', { device: 'fresh-farmer' });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'none');
  assert.deepEqual(res.json.days, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(res.json.online, false);
  assert.equal(res.json.canSubmit, false);
  assert.ok(res.json.missing.includes('licence') && res.json.missing.includes('rc') && res.json.missing.includes('vehicleNumber'));
});

test('the details are tidied and saved, and a draft says what is still missing', async () => {
  const device = 'tidy-farmer';
  const res = await save(device, { vehicleType: 'pickup', vehicleNumber: 'mh 12 ab 7777', capacityKg: 600, phone: '+91 98765 43210', maxDistanceKm: 15, days: [0, 1, 2, 3, 4, 5], freeFrom: '07:00', freeUntil: '17:30' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.status, 'draft');
  assert.equal(res.json.vehicleNumber, 'MH12AB7777');
  assert.equal(res.json.phone, '9876543210');
  assert.equal(res.json.vehicleLabel, 'Pickup / small van');
  assert.equal(res.json.maxDistanceKm, 15);
  assert.deepEqual(res.json.days, [0, 1, 2, 3, 4, 5]);
  assert.equal(res.json.freeFrom, '07:00');
  assert.deepEqual(res.json.missing.sort(), ['licence', 'rc']);
  assert.equal(res.json.canSubmit, false);
  // Partial updates keep the rest.
  const again = await save(device, { maxDistanceKm: 20 });
  assert.equal(again.json.vehicleNumber, 'MH12AB7777');
  assert.equal(again.json.maxDistanceKm, 20);
});

test('bad details are refused with a reason', async () => {
  const device = 'bad-farmer';
  const cases = [
    [{ vehicleType: 'helicopter' }, /vehicleType/],
    [{ vehicleNumber: 'x' }, /registration number/],
    [{ phone: '123' }, /10-digit/],
    [{ vehicleType: 'bike', capacityKg: 2000 }, /bike can carry 5 to 80 kg/],
    [{ capacityKg: 1.5 }, /integer|whole number/],
    [{ maxDistanceKm: 0 }, /maxDistanceKm/],
    [{ maxDistanceKm: 99 }, /maxDistanceKm/],
    [{ days: [] }, /days/],
    [{ days: [7] }, /days/],
    [{ freeFrom: '9am' }, /freeFrom/],
    [{ freeFrom: '18:00', freeUntil: '08:00' }, /earlier time/],
  ];
  for (const [body, pattern] of cases) {
    const res = await save(device, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(errorText(res), pattern, JSON.stringify(body));
  }
  assert.equal((await save(device, { reviewCenterId: 'center-nope' })).status, 404);
});

test('the licence and RC are photos or PDFs, judged by their bytes, and kept privately', async () => {
  const device = 'docs-farmer';
  const jpeg = await testImage();
  const ok = await upload(device, 'licence', jpeg);
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.documents.licence.contentType, 'image/jpeg');
  assert.ok(ok.json.documents.licence.sizeBytes > 0);
  assert.equal(ok.json.documents.rc, null);
  assert.equal(ok.json.data, undefined, 'the bytes never come back in the profile');

  const pdf = await upload(device, 'rc', Buffer.from('%PDF-1.4\n%fake but starts like a pdf\n'), 'application/pdf');
  assert.equal(pdf.status, 201);
  assert.equal(pdf.json.documents.rc.contentType, 'application/pdf');

  // A text file that claims to be a photo is not one.
  const fake = await upload(device, 'rc', Buffer.from('just some words'), 'image/jpeg');
  assert.equal(fake.status, 422);
  assert.match(errorText(fake), /photo .* or a PDF/);
  assert.equal((await upload(device, 'passport', jpeg)).status, 404);
  const big = await upload(device, 'licence', Buffer.alloc(5 * 1024 * 1024 + 10, 1));
  assert.ok([413, 400].includes(big.status), `too large is refused (${big.status})`);

  // The owner can see what they sent, but it is never cached or public.
  const back = await fetch(`${base}/v1/delivery/partner/documents/licence`, { headers: { 'x-device-id': device } });
  assert.equal(back.status, 200);
  assert.equal(back.headers.get('content-type'), 'image/jpeg');
  assert.match(back.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), jpeg);
  assert.equal((await fetch(`${base}/v1/delivery/partner/documents/rc`, { headers: { 'x-device-id': 'someone-else' } })).status, 404, "another farmer cannot read it");
});

test('applying needs everything, and says exactly what is missing', async () => {
  const device = 'incomplete-farmer';
  const none = await call('POST', '/v1/delivery/partner/submit', { device });
  assert.equal(none.status, 400);
  assert.equal(none.json.code, 'incomplete');

  await save(device, details());
  const noPapers = await call('POST', '/v1/delivery/partner/submit', { device });
  assert.equal(noPapers.status, 400);
  assert.match(errorText(noPapers), /photo of your driving licence, a photo of the RC/);
  assert.deepEqual(noPapers.json.missing.sort(), ['licence', 'rc']);

  await upload(device, 'licence', await testImage());
  await upload(device, 'rc', await testImage());
  const noCenter = await call('POST', '/v1/delivery/partner/submit', { device });
  assert.equal(noCenter.status, 400);
  assert.equal(noCenter.json.code, 'no_center', 'no location and no chosen center: nobody to check him');
});

test('with everything in, the application goes to the chosen center and its operator is told', async () => {
  const c = await makeCenter('apply');
  const device = await readyFarmer('sita', c);
  assert.equal((await mine(device)).canSubmit, true);

  const res = await call('POST', '/v1/delivery/partner/submit', { device });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.status, 'pending');
  assert.equal(res.json.reviewCenterId, c.centerId);
  assert.equal(res.json.reviewCenterName, 'Center apply');
  assert.ok(res.json.submittedAt);

  const told = await alerts(c.device);
  assert.equal(told.length, 1);
  assert.equal(told[0].title, 'A farmer wants to deliver');
  assert.match(told[0].body, /Farmer sita applied to deliver with a pickup \/ small van \(MH12AB\d+\)/);
  assert.equal(told[0].refId, device);

  assert.equal((await call('POST', '/v1/delivery/partner/submit', { device })).status, 409, 'cannot apply twice');
});

test('without a chosen center the nearest working one checks him', async () => {
  // Far from every other test's centers, so "nearest" is only about these two.
  const near = await makeCenter('near-check', 1.02);
  await makeCenter('far-check', 1.2);
  const device = `locator-${counter += 1}`;
  await call('PUT', '/v1/farmer/profile', { device, body: { name: 'Locator', village: 'Shirur', latitude: 19.5, longitude: 74.0 } });
  await save(device, details());
  await upload(device, 'licence', await testImage());
  await upload(device, 'rc', await testImage());
  const res = await call('POST', '/v1/delivery/partner/submit', { device });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.reviewCenterId, near.centerId);
});

test('a vehicle can be registered by only one active partner', async () => {
  const c = await makeCenter('plates');
  const first = await submitted('first', c, { vehicleNumber: 'MH14ZZ9001' });
  assert.ok(first);
  const second = await readyFarmer('second', c, { vehicleNumber: 'mh 14 zz 9001' });
  const res = await call('POST', '/v1/delivery/partner/submit', { device: second });
  assert.equal(res.status, 409);
  assert.match(errorText(res), /already registered/);
  assert.equal((await mine(second)).status, 'draft', 'the loser stays a draft');
  // Once the first is rejected the plate is free again.
  await act(c.device, first, 'reject', 'Photo unreadable');
  assert.equal((await call('POST', '/v1/delivery/partner/submit', { device: second })).status, 200);
});

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

test('the center\'s operator sees their applicants, oldest waiting first, and nobody else\'s', async () => {
  const c = await makeCenter('queue');
  const other = await makeCenter('queue-other');
  const a = await submitted('qa', c);
  const b = await submitted('qb', c);
  const theirs = await submitted('qc', other);
  await readyFarmer('qdraft', c); // never submitted

  const list = (await call('GET', '/v1/operator/delivery-partners', { device: c.device })).json;
  assert.deepEqual(list.map((p) => p.userId), [a, b], 'oldest application first; drafts and other centers are not shown');
  assert.equal(list[0].name, 'Farmer qa');
  assert.equal(list[0].status, 'pending');
  assert.equal(list[0].capacityKg, 600);
  assert.equal((await call('GET', '/v1/operator/delivery-partners?status=approved', { device: c.device })).json.length, 0);
  assert.equal((await call('GET', '/v1/operator/delivery-partners?status=bogus', { device: c.device })).status, 400);
  assert.equal((await call('GET', '/v1/operator/delivery-partners?status=draft', { device: c.device })).status, 400);
  assert.equal((await call('GET', '/v1/operator/delivery-partners?q=Farmer%20qb', { device: c.device })).json.length, 1);

  assert.equal((await call('GET', `/v1/operator/delivery-partners/${theirs}`, { device: c.device })).status, 404, "another center's applicant");
  assert.equal((await act(c.device, theirs, 'approve')).status, 404);
  assert.equal((await call('GET', `/v1/operator/delivery-partners/${a}/documents/rc`, { device: other.device })).status, 404);
});

test('the reviewer sees the papers and the history, and can open the documents', async () => {
  const c = await makeCenter('review-detail');
  const device = await submitted('rd', c);
  const detail = (await call('GET', `/v1/operator/delivery-partners/${device}`, { device: c.device })).json;
  assert.equal(detail.userId, device);
  assert.equal(detail.documents.licence.contentType, 'image/jpeg');
  assert.equal(detail.documents.rc.contentType, 'image/png');
  assert.deepEqual(detail.events.map((e) => e.action).sort(), ['document_uploaded', 'document_uploaded', 'submitted']);
  assert.equal(detail.phone, '9876543210', 'the operator needs a number to reach him');

  const doc = await fetch(`${base}/v1/operator/delivery-partners/${device}/documents/rc`, { headers: { 'x-device-id': c.device } });
  assert.equal(doc.status, 200);
  assert.equal(doc.headers.get('content-type'), 'image/png');
  assert.match(doc.headers.get('cache-control'), /no-store/);
});

test('rejecting needs a reason, tells the farmer why, and lets them fix and try again', async () => {
  const c = await makeCenter('reject');
  const device = await submitted('rj', c);
  assert.equal((await act(c.device, device, 'reject')).status, 400, 'a reason is required');
  assert.equal((await act(c.device, device, 'reject', '   ')).status, 400);

  const res = await act(c.device, device, 'reject', 'The RC photo is blurred');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.status, 'rejected');
  const seen = await mine(device);
  assert.equal(seen.status, 'rejected');
  assert.equal(seen.rejectionReason, 'The RC photo is blurred');
  assert.equal(seen.canSubmit, true, 'he can resubmit after fixing');
  const told = (await alerts(device)).find((n) => n.title === 'Your delivery application needs changes');
  assert.match(told.body, /The RC photo is blurred/);
  assert.equal((await act(c.device, device, 'reject', 'again')).status, 409, 'already rejected');

  // Fixing a paper puts it back to a draft (the old reason is cleared), then he applies again.
  await upload(device, 'rc', await testImage([1, 2, 3]));
  const draft = await mine(device);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.rejectionReason, null);
  assert.equal((await call('POST', '/v1/delivery/partner/submit', { device })).status, 200);
  assert.equal((await mine(device)).status, 'pending');
});

test('approving tells the farmer, and only then can he switch on "free now"', async () => {
  const c = await makeCenter('approve');
  const device = await submitted('ap', c);
  const early = await call('PUT', '/v1/delivery/partner/online', { device, body: { online: true } });
  assert.equal(early.status, 403, 'not before the papers are approved');

  const res = await act(c.device, device, 'approve');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'approved');
  assert.ok(res.json.reviewedAt);
  assert.equal((await alerts(device)).find((n) => n.title === 'You are approved to deliver').refId, device);

  const on = await call('PUT', '/v1/delivery/partner/online', { device, body: { online: true } });
  assert.equal(on.status, 200);
  assert.equal(on.json.online, true);
  assert.equal((await call('PUT', '/v1/delivery/partner/online', { device, body: { online: 'yes' } })).status, 400);
  assert.equal((await call('PUT', '/v1/delivery/partner/online', { device, body: { online: false } })).json.online, false);
  assert.equal((await act(c.device, device, 'approve')).status, 409, 'already approved');
});

test('changing the vehicle or a paper sends an approved partner back for checking; hours and distance do not', async () => {
  const c = await makeCenter('recheck');
  const device = await submitted('rc1', c);
  await act(c.device, device, 'approve');
  await call('PUT', '/v1/delivery/partner/online', { device, body: { online: true } });
  const before = (await alerts(c.device)).length;

  // Availability is the farmer's own business.
  const free = await save(device, { maxDistanceKm: 25, days: [0, 1], freeFrom: '09:00', freeUntil: '15:00' });
  assert.equal(free.json.status, 'approved');
  assert.equal(free.json.online, true);
  assert.equal((await alerts(c.device)).length, before);

  // Saying the same thing again changes nothing either.
  assert.equal((await save(device, { capacityKg: 600 })).json.status, 'approved');

  // A different capacity is a different vehicle load: checked again, and off the road until then.
  const changed = await save(device, { capacityKg: 900 });
  assert.equal(changed.json.status, 'pending');
  assert.equal(changed.json.online, false);
  const told = await alerts(c.device);
  assert.equal(told.length, before + 1);
  assert.equal(told[0].title, 'A delivery partner changed their details');
  assert.match(told[0].body, /changed the capacity/);
  await act(c.device, device, 'approve');

  // So is a new photo of a paper.
  await upload(device, 'licence', await testImage([9, 9, 9]));
  assert.equal((await mine(device)).status, 'pending');
  const events = (await call('GET', `/v1/operator/delivery-partners/${device}`, { device: c.device })).json.events.map((e) => e.action);
  assert.ok(events.includes('resubmitted'));
});

test('suspending needs a reason, stops deliveries and edits, and can be lifted', async () => {
  const c = await makeCenter('suspend');
  const device = await submitted('su', c);
  await act(c.device, device, 'approve');
  await call('PUT', '/v1/delivery/partner/online', { device, body: { online: true } });

  assert.equal((await act(c.device, device, 'suspend')).status, 400, 'a reason is required');
  const res = await act(c.device, device, 'suspend', 'Complaints from two farmers');
  assert.equal(res.json.status, 'suspended');
  const seen = await mine(device);
  assert.equal(seen.online, false, 'off the road at once');
  assert.match((await alerts(device)).find((n) => n.title === 'Your delivery account was suspended').body, /Complaints from two farmers/);
  assert.equal((await save(device, { maxDistanceKm: 5 })).status, 403, 'no edits while suspended');
  assert.equal((await upload(device, 'rc', await testImage())).status, 403);
  assert.equal((await call('POST', '/v1/delivery/partner/submit', { device })).status, 403);
  assert.equal((await call('PUT', '/v1/delivery/partner/online', { device, body: { online: true } })).status, 403);

  assert.equal((await act(c.device, device, 'reactivate')).json.status, 'approved');
  assert.equal((await call('PUT', '/v1/delivery/partner/online', { device, body: { online: true } })).status, 200);
  assert.equal((await act(c.device, device, 'reactivate')).status, 409, 'nothing to lift');
});

test('actions that do not fit where the application is are refused', async () => {
  const c = await makeCenter('order-of-things');
  const device = await submitted('ooo', c);
  assert.equal((await act(c.device, device, 'suspend', 'x')).status, 409, 'only an approved partner can be suspended');
  assert.equal((await act(c.device, device, 'reactivate')).status, 409);
  assert.equal((await act(c.device, device, 'dance')).status, 400);
  assert.equal((await act(c.device, 'nobody-at-all', 'approve')).status, 404);
});

// ---------------------------------------------------------------------------
// The platform
// ---------------------------------------------------------------------------

test('an admin sees every center\'s applicants, and their actions are audited', async () => {
  const a = await makeCenter('adm-a');
  const b = await makeCenter('adm-b');
  const pa = await submitted('ada', a);
  const pb = await submitted('adb', b);

  const all = (await call('GET', '/v1/admin/delivery-partners?limit=200', { device: 'admin' })).json;
  const ids = all.map((p) => p.userId);
  assert.ok(ids.includes(pa) && ids.includes(pb));
  const byCenter = (await call('GET', `/v1/admin/delivery-partners?centerId=${b.centerId}`, { device: 'admin' })).json;
  assert.deepEqual(byCenter.map((p) => p.userId), [pb]);
  assert.equal((await call('GET', `/v1/admin/delivery-partners?status=pending&q=${encodeURIComponent('Farmer ada')}`, { device: 'admin' })).json.length, 1);
  assert.equal((await call('GET', '/v1/admin/delivery-partners?status=bogus', { device: 'admin' })).status, 400);

  const detail = (await call('GET', `/v1/admin/delivery-partners/${pa}`, { device: 'admin' })).json;
  assert.equal(detail.reviewCenterName, 'Center adm-a');
  assert.equal((await fetch(`${base}/v1/admin/delivery-partners/${pa}/documents/licence`, { headers: { 'x-device-id': 'admin' } })).status, 200);

  const res = await act('admin', pa, 'approve', undefined, 'admin');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'approved');
  const audit = (await call('GET', `/v1/admin/audit?targetType=delivery_partner&targetId=${pa}`, { device: 'admin' })).json;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'delivery_partner.approve');
  // Their own center's operator can also still act on the same person.
  assert.equal((await act(b.device, pb, 'reject', 'Papers do not match', 'operator')).json.status, 'rejected');
  assert.equal((await act('admin', pb, 'reject', 'again', 'admin')).status, 409);
});

test('stopping delivery removes the application and the papers', async () => {
  const c = await makeCenter('quit');
  const device = await readyFarmer('qt', c);
  assert.equal((await call('DELETE', '/v1/delivery/partner', { device })).status, 204);
  assert.equal((await mine(device)).status, 'none');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM delivery_document WHERE user_id = $1', [device])).rows[0].n, 0);
  assert.equal((await call('DELETE', '/v1/delivery/partner', { device })).status, 404, 'nothing left to remove');
});

test('only an operator can use the operator side of this', async () => {
  assert.equal((await call('GET', '/v1/operator/delivery-partners', { device: 'just-a-farmer' })).status, 403);
});
