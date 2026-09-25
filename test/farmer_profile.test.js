process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.RATE_LIMIT_OTP = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');

let server;
let base;
let db;

const call = async (method, path, { body, device = 'p-1' } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-device-id': device },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

test.before(async () => {
  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  db = await openTestDb('t_farmer_profile');
  server = createApp(db).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

const ADDRESS = { fullName: 'Asha Patil', phone: '98765 43210', line1: 'Gat 12, Near Temple', pincode: '412210', village: 'Shirur', district: 'Pune' };

test('contact details are saved, checked and kept apart from the login', async () => {
  assert.deepEqual((await call('GET', '/v1/farmer/contact')).json, { email: '', phone: '', loginEmail: '' });
  const put = await call('PUT', '/v1/farmer/contact', { body: { email: 'asha@example.com', phone: '+91 98765-43210' } });
  assert.equal(put.status, 200);
  assert.deepEqual([put.json.email, put.json.phone], ['asha@example.com', '+919876543210']);
  // A partial update leaves the other field alone.
  assert.equal((await call('PUT', '/v1/farmer/contact', { body: { email: '' } })).json.phone, '+919876543210');
  assert.equal((await call('PUT', '/v1/farmer/contact', { body: { email: 'nope' } })).status, 400);
  assert.equal((await call('PUT', '/v1/farmer/contact', { body: { phone: '12' } })).status, 400);
});

test('addresses: the first is the default, one default at a time, deleting hands it on', async () => {
  const d = 'addr-farmer';
  const a = await call('POST', '/v1/farmer/addresses', { device: d, body: ADDRESS });
  assert.equal(a.status, 201);
  assert.equal(a.json.isDefault, true);
  assert.equal(a.json.phone, '9876543210');
  assert.equal(a.json.state, 'Maharashtra');

  const b = await call('POST', '/v1/farmer/addresses', { device: d, body: { ...ADDRESS, label: 'Farm', line1: 'Survey 44', latitude: 18.83, longitude: 74.37 } });
  assert.equal(b.json.isDefault, false);
  assert.equal(b.json.latitude, 18.83);

  const c = await call('POST', '/v1/farmer/addresses', { device: d, body: { ...ADDRESS, label: 'Work', isDefault: true } });
  assert.equal(c.json.isDefault, true);
  let list = (await call('GET', '/v1/farmer/addresses', { device: d })).json;
  assert.equal(list.length, 3);
  assert.deepEqual(list.filter((x) => x.isDefault).map((x) => x.label), ['Work']);
  assert.equal(list[0].label, 'Work', 'the default comes first');

  assert.equal((await call('POST', `/v1/farmer/addresses/${a.json.addressId}/default`, { device: d })).json.isDefault, true);
  list = (await call('GET', '/v1/farmer/addresses', { device: d })).json;
  assert.deepEqual(list.filter((x) => x.isDefault).map((x) => x.label), ['Home']);

  const edited = await call('PATCH', `/v1/farmer/addresses/${b.json.addressId}`, { device: d, body: { landmark: 'Blue gate', fullName: 'Asha P.' } });
  assert.equal(edited.json.landmark, 'Blue gate');
  assert.equal(edited.json.fullName, 'Asha P.');
  assert.equal(edited.json.line1, 'Survey 44');

  assert.equal((await call('DELETE', `/v1/farmer/addresses/${a.json.addressId}`, { device: d })).status, 204);
  list = (await call('GET', '/v1/farmer/addresses', { device: d })).json;
  assert.equal(list.length, 2);
  assert.equal(list.filter((x) => x.isDefault).length, 1, 'a default is always kept');
});

test('addresses are private, validated and capped', async () => {
  const mine = await call('POST', '/v1/farmer/addresses', { device: 'owner-a', body: ADDRESS });
  assert.equal((await call('GET', '/v1/farmer/addresses', { device: 'owner-b' })).json.length, 0);
  assert.equal((await call('PATCH', `/v1/farmer/addresses/${mine.json.addressId}`, { device: 'owner-b', body: { line1: 'x-y-z' } })).status, 404);
  assert.equal((await call('DELETE', `/v1/farmer/addresses/${mine.json.addressId}`, { device: 'owner-b' })).status, 404);

  assert.equal((await call('POST', '/v1/farmer/addresses', { device: 'v', body: { ...ADDRESS, pincode: '12' } })).status, 400);
  assert.equal((await call('POST', '/v1/farmer/addresses', { device: 'v', body: { ...ADDRESS, phone: 'abc' } })).status, 400);
  assert.equal((await call('POST', '/v1/farmer/addresses', { device: 'v', body: { ...ADDRESS, latitude: 18 } })).status, 400);
  assert.equal((await call('POST', '/v1/farmer/addresses', { device: 'v', body: { fullName: 'x' } })).status, 400);

  for (let i = 0; i < 10; i += 1) assert.equal((await call('POST', '/v1/farmer/addresses', { device: 'cap', body: ADDRESS })).status, 201);
  assert.equal((await call('POST', '/v1/farmer/addresses', { device: 'cap', body: ADDRESS })).status, 409);
});

test('scheme details are saved once, merged, and can be cleared', async () => {
  const d = 'details-farmer';
  assert.deepEqual((await call('GET', '/v1/farmer/details', { device: d })).json.details, {});
  const first = await call('PUT', '/v1/farmer/details', { device: d, body: { category: 'obc', hasBankAccount: true, primaryCrops: ['Soybean', 'Soybean', 'Cotton'] } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.details, { category: 'obc', hasBankAccount: true, primaryCrops: ['Soybean', 'Cotton'] });
  const second = await call('PUT', '/v1/farmer/details', { device: d, body: { hasKcc: false, category: null } });
  assert.deepEqual(second.json.details, { hasBankAccount: true, primaryCrops: ['Soybean', 'Cotton'], hasKcc: false });
  assert.equal((await call('PUT', '/v1/farmer/details', { device: d, body: { category: 'royal' } })).status, 400);
  assert.equal((await call('PUT', '/v1/farmer/details', { device: d, body: { madeUp: true } })).status, 400);
  assert.equal((await call('PUT', '/v1/farmer/details', { device: d, body: { dateOfBirth: '2031-01-01' } })).status, 400);
  assert.equal((await call('PUT', '/v1/farmer/details', { device: d, body: { hasKcc: 'yes' } })).status, 400);
  assert.equal((await call('PUT', '/v1/farmer/details', { device: d, body: { dateOfBirth: '1985-06-30' } })).status, 200);
});

test('my community activity: posts and replies, with the post each reply is under', async () => {
  const d = 'talker';
  const post = await call('POST', '/v1/community/posts', { device: d, body: { title: 'Yellow leaves on soybean', content: 'What should I do about it?', problemTypeTag: 'nutrientDeficiency', cropTag: 'Soybean' } });
  assert.equal(post.status, 201);
  const other = await call('POST', '/v1/community/posts', { device: 'someone-else', body: { title: 'Pest on cotton', content: 'Small white insects everywhere', problemTypeTag: 'pest' } });
  await call('POST', `/v1/community/posts/${other.json.postId}/comments`, { device: d, body: { content: 'Try neem oil spray' } });
  const mine = (await call('GET', '/v1/community/mine', { device: d })).json;
  assert.deepEqual(mine.posts.map((p) => p.title), ['Yellow leaves on soybean']);
  assert.equal(mine.comments.length, 1);
  assert.equal(mine.comments[0].postTitle, 'Pest on cotton');
  assert.equal(mine.comments[0].content, 'Try neem oil spray');
  const nobody = (await call('GET', '/v1/community/mine', { device: 'quiet' })).json;
  assert.deepEqual(nobody, { posts: [], comments: [] });
});
