process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = require('jose');

const SUPABASE = 'https://test-project.supabase.co';
const ISSUER = `${SUPABASE}/auth/v1`;

let server;
let base;
let db;
let signingKey;
let strangerKey;

const token = (key, { sub = 'user-a', issuer = ISSUER, audience = 'authenticated', expiresIn = '1h' } = {}) =>
  new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);

const call = async (method, path, { body, bearer, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

test.before(async () => {
  const pair = await generateKeyPair('ES256');
  signingKey = pair.privateKey;
  strangerKey = (await generateKeyPair('ES256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };

  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  db = await openTestDb('t_auth');
  const app = createApp(db, { auth: { supabaseUrl: SUPABASE, jwks: createLocalJWKSet({ keys: [jwk] }) } });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

test('health stays open, everything under /v1 needs a token', async () => {
  assert.equal((await call('GET', '/health')).status, 200);
  const res = await call('GET', '/v1/products');
  assert.equal(res.status, 401);
  assert.match(res.json.error, /sign in/i);
});

test('a token signed by another key is rejected', async () => {
  const res = await call('GET', '/v1/products', { bearer: await token(strangerKey) });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'Invalid sign-in token');
});

test('wrong issuer, wrong audience and garbage tokens are rejected', async () => {
  for (const bad of [
    await token(signingKey, { issuer: 'https://evil.supabase.co/auth/v1' }),
    await token(signingKey, { audience: 'anon' }),
    'not.a.jwt',
  ]) {
    assert.equal((await call('GET', '/v1/products', { bearer: bad })).status, 401);
  }
});

test('an expired token says so', async () => {
  const res = await call('GET', '/v1/products', { bearer: await token(signingKey, { expiresIn: '-1m' }) });
  assert.equal(res.status, 401);
  assert.match(res.json.error, /expired/i);
});

test('a valid token gets through, and farmer data belongs to the token user', async () => {
  const a = await token(signingKey, { sub: 'user-a' });
  const b = await token(signingKey, { sub: 'user-b' });

  assert.equal((await call('GET', '/v1/products', { bearer: a })).status, 200);

  await call('PUT', '/v1/farmer/profile', { bearer: a, body: { name: 'Alice', village: 'Shirur' } });
  assert.equal((await call('GET', '/v1/farmer/profile', { bearer: a })).json.name, 'Alice');
  assert.equal((await call('GET', '/v1/farmer/profile', { bearer: b })).json.name, 'Farmer');
});

test('a claimed device id cannot be used to read another user\'s data', async () => {
  const a = await token(signingKey, { sub: 'user-c' });
  const b = await token(signingKey, { sub: 'user-d' });
  await call('PUT', '/v1/farmer/profile', { bearer: a, body: { name: 'Carol' } });

  // User D names user C as their device id (header and query): still gets D's data.
  const viaHeader = await call('GET', '/v1/farmer/profile', { bearer: b, headers: { 'x-device-id': 'user-c' } });
  const viaQuery = await call('GET', '/v1/farmer/profile?device_id=user-c', { bearer: b });
  assert.equal(viaHeader.json.name, 'Farmer');
  assert.equal(viaQuery.json.name, 'Farmer');
});

test('orders and soil scans are owned by the token user, not by what the client claims', async () => {
  const a = await token(signingKey, { sub: 'user-e' });
  const b = await token(signingKey, { sub: 'user-f' });

  const order = await call('POST', '/v1/orders', { bearer: a, body: { items: [{ productId: 'p-neemcake', quantity: 1 }] } });
  assert.equal(order.status, 201);
  assert.equal((await call('GET', '/v1/orders', { bearer: a })).json.length, 1);
  assert.equal((await call('GET', '/v1/orders', { bearer: b })).json.length, 0);
  assert.equal((await call('GET', `/v1/orders/${order.json.id}`, { bearer: b })).status, 404);

  // User E uploads a scan while claiming to be user F in the metadata.
  const form = new FormData();
  form.append('image', new Blob([await require('./helpers').testJpeg()], { type: 'image/jpeg' }), 'x.jpg');
  form.append('metadata_json', JSON.stringify({ device_id: 'user-f' }));
  const scan = await fetch(`${base}/v1/analyze`, { method: 'POST', headers: { authorization: `Bearer ${a}` }, body: form });
  assert.equal(scan.status, 200);
  assert.equal((await call('GET', '/v1/history', { bearer: a })).json.length, 1);
  assert.equal((await call('GET', '/v1/history', { bearer: b })).json.length, 0);
});
