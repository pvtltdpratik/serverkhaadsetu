process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');

let server;
let base;
let db;

const call = async (method, path, { body, device, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(device ? { 'x-device-id': device } : { 'x-device-id': 'default-tester' }),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

test.before(async () => {
  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  db = await openTestDb('t_community');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

test('list: seeded posts, filters, and X-Total-Count', async () => {
  const all = await call('GET', '/v1/community/posts');
  assert.equal(all.json.length, 6);
  assert.equal(all.json[0].postId, 'post-3'); // newest first — seeded 1 day ago, the most recent of the six
  assert.ok('commentCount' in all.json[0] && 'likeCount' in all.json[0]);

  assert.equal((await call('GET', '/v1/community/posts?crop=wheat')).json.length, 2); // case-insensitive
  assert.equal((await call('GET', '/v1/community/posts?district=Pune')).json.length, 3);
  assert.equal((await call('GET', '/v1/community/posts?problemType=pest')).json.length, 1);
  assert.equal((await call('GET', '/v1/community/posts?q=bollworm')).json.length, 1);

  const res = await fetch(`${base}/v1/community/posts?limit=2&offset=0`, { headers: { 'x-device-id': 'x' } });
  assert.equal(res.headers.get('x-total-count'), '6');
  assert.equal((await res.json()).length, 2);
});

test('an invalid problemType filter is a 400, not a silent empty list', async () => {
  const res = await call('GET', '/v1/community/posts?problemType=nonsense');
  assert.equal(res.status, 400);
  assert.match(res.json.error, /problemType/);
});

test('create: validation, farmerId from the caller, and farmerName resolved from profiles', async () => {
  const tooShort = await call('POST', '/v1/community/posts', { body: { title: 'Hi', content: 'ok', problemTypeTag: 'general' } });
  assert.equal(tooShort.status, 400);

  const badTag = await call('POST', '/v1/community/posts', {
    body: { title: 'A real question title', content: 'A real question body here.', problemTypeTag: 'not-a-type' },
  });
  assert.equal(badTag.status, 400);

  await call('PUT', '/v1/farmer/profile', { device: 'author-1', body: { name: 'Kiran Bhosale' } });
  const created = await call('POST', '/v1/community/posts', {
    device: 'author-1',
    body: { title: 'Does gypsum help sodic soil?', content: 'Reading conflicting advice, want real experience.', cropTag: 'Rice', districtTag: 'Solapur', problemTypeTag: 'general' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.farmerId, 'author-1');
  assert.equal(created.json.farmerName, 'Kiran Bhosale');
  assert.equal(created.json.commentCount, 0);
  assert.equal(created.json.likeCount, 0);

  // A farmer who never saved a profile still gets a post, with the default name.
  const anon = await call('POST', '/v1/community/posts', {
    device: 'author-2',
    body: { title: 'Anyone selling neem cake nearby?', content: 'Looking for a local source before the season starts.', problemTypeTag: 'general' },
  });
  assert.equal(anon.json.farmerName, 'Farmer');
});

test('detail: full content plus comments in order, 404 for an unknown post', async () => {
  const detail = await call('GET', '/v1/community/posts/post-2');
  assert.equal(detail.status, 200);
  assert.equal(detail.json.title, 'Best time to spray for bollworm in cotton?');
  assert.ok(Array.isArray(detail.json.comments));
  assert.equal(detail.json.comments.length, 4);
  const times = detail.json.comments.map((c) => new Date(c.createdAt).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));

  assert.equal((await call('GET', '/v1/community/posts/does-not-exist')).status, 404);
});

test('comments: a plain farmer comment, an agronomist-attributed one, and a rejected fake agronomist', async () => {
  const plain = await call('POST', '/v1/community/posts/post-3/comments', { device: 'helper-1', body: { content: 'Try holding for a week, prices often recover.' } });
  assert.equal(plain.status, 201);
  assert.equal(plain.json.isAiGenerated, false);
  assert.equal(plain.json.isAgronomistVerified, false);
  assert.equal(plain.json.agronomistId, null);

  const fromAgronomist = await call('POST', '/v1/community/posts/post-3/comments', {
    device: 'anyone',
    body: { content: 'Mandi arrivals usually ease in a week; holding a few days is reasonable if storage allows.', agronomistId: 'agro-sanjay' },
  });
  assert.equal(fromAgronomist.status, 201);
  assert.equal(fromAgronomist.json.isAgronomistVerified, true);
  assert.equal(fromAgronomist.json.agronomistId, 'agro-sanjay');
  assert.equal(fromAgronomist.json.agronomistName, 'Dr. Sanjay Deshpande');

  const fake = await call('POST', '/v1/community/posts/post-3/comments', { body: { content: 'Trust me.', agronomistId: 'agro-does-not-exist' } });
  assert.equal(fake.status, 404);

  // A valid-length body so this actually reaches the post lookup (a too-short
  // body would 400 on validation before the post is even looked up).
  assert.equal((await call('POST', '/v1/community/posts/does-not-exist/comments', { body: { content: 'A long enough comment body.' } })).status, 404);
  assert.equal((await call('POST', '/v1/community/posts/post-3/comments', { body: { content: 'x' } })).status, 400); // too short
});

test('verify: only an AI-generated comment can be verified, only by a verified agronomist', async () => {
  // Seeded comments are ordinary farmer comments, not AI-generated.
  const notAi = await call('PATCH', '/v1/community/comments/post-4-comment-0/verify', { body: { agronomistId: 'agro-sanjay' } });
  assert.equal(notAi.status, 409);

  assert.equal((await call('PATCH', '/v1/community/comments/does-not-exist/verify', { body: { agronomistId: 'agro-sanjay' } })).status, 404);

  // Plant a fake AI-generated comment directly — Phase 2 will do this via the AI service.
  await db.query("INSERT INTO post_comment (comment_id, post_id, farmer_id, content, is_ai_generated) VALUES ('comment-ai-1','post-4','ai-assistant','Draft answer.', true)");

  const fakeAgronomist = await call('PATCH', '/v1/community/comments/comment-ai-1/verify', { body: { agronomistId: 'agro-does-not-exist' } });
  assert.equal(fakeAgronomist.status, 404);

  const verified = await call('PATCH', '/v1/community/comments/comment-ai-1/verify', { body: { agronomistId: 'agro-sanjay' } });
  assert.equal(verified.status, 200);
  assert.equal(verified.json.isAgronomistVerified, true);
  assert.equal(verified.json.agronomistId, 'agro-sanjay');
});

test('like: toggles, is per-farmer, and 404s for an unknown post', async () => {
  const before = (await call('GET', '/v1/community/posts/post-5')).json.likeCount;

  const first = await call('POST', '/v1/community/posts/post-5/like', { device: 'liker-a' });
  assert.deepEqual(first.json, { liked: true, likeCount: before + 1 });

  const second = await call('POST', '/v1/community/posts/post-5/like', { device: 'liker-a' });
  assert.deepEqual(second.json, { liked: false, likeCount: before });

  // A different farmer liking is independent of the first farmer's state.
  const other = await call('POST', '/v1/community/posts/post-5/like', { device: 'liker-b' });
  assert.deepEqual(other.json, { liked: true, likeCount: before + 1 });

  assert.equal((await call('POST', '/v1/community/posts/does-not-exist/like')).status, 404);
});

test('concurrent likes from different farmers land on an exact count, and same-farmer races never corrupt the row', async () => {
  const before = (await call('GET', '/v1/community/posts/post-6')).json.likeCount;

  await Promise.all(Array.from({ length: 15 }, (_, i) => call('POST', '/v1/community/posts/post-6/like', { device: `race-${i}` })));
  assert.equal((await call('GET', '/v1/community/posts/post-6')).json.likeCount, before + 15);

  // Same farmer, 9 concurrent toggles: whatever the final parity is, the row
  // must end up in a consistent state (not a crash, not a duplicate like).
  const results = await Promise.all(Array.from({ length: 9 }, () => call('POST', '/v1/community/posts/post-6/like', { device: 'race-same' })));
  assert.ok(results.every((r) => r.status === 200));
  const finalCount = (await call('GET', '/v1/community/posts/post-6')).json.likeCount;
  assert.ok(finalCount === before + 15 || finalCount === before + 16);
  const rows = (await db.query("SELECT count(*)::int AS n FROM post_like WHERE post_id = 'post-6' AND farmer_id = 'race-same'")).rows[0].n;
  assert.equal(rows, finalCount - (before + 15));
});
