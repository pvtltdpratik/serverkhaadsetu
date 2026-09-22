const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { ensureDatabaseExists } = require('../src/db/bootstrap');

// These need a real Postgres server (creating a database is the thing under
// test) — same one the other suites use, via TEST_DATABASE_URL, but this
// file talks to the *server*, not a database inside it, so it derives the
// admin connection from that URL rather than opening a schema of its own.
const BASE = new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/khaad_test');

const urlFor = (dbName) => {
  const u = new URL(BASE);
  u.pathname = `/${dbName}`;
  return u.toString();
};

const databaseExists = async (name) => {
  const admin = new Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  try {
    return (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount > 0;
  } finally {
    await admin.end();
  }
};

const dropDatabase = async (name) => {
  const admin = new Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await admin.end();
  }
};

test('creates the database when it does not exist yet', async () => {
  const name = `khaad_boot_${Date.now()}`;
  await dropDatabase(name);
  assert.equal(await databaseExists(name), false);

  await ensureDatabaseExists(urlFor(name));
  assert.equal(await databaseExists(name), true);

  await dropDatabase(name);
});

test('is a no-op when the database already exists', async () => {
  const name = `khaad_boot_${Date.now()}_again`;
  await ensureDatabaseExists(urlFor(name));
  await ensureDatabaseExists(urlFor(name)); // second call must not error
  assert.equal(await databaseExists(name), true);
  await dropDatabase(name);
});

test('concurrent first starts do not race each other into an error', async () => {
  const name = `khaad_boot_${Date.now()}_race`;
  await dropDatabase(name);
  await Promise.all(Array.from({ length: 5 }, () => ensureDatabaseExists(urlFor(name))));
  assert.equal(await databaseExists(name), true);
  await dropDatabase(name);
});

test('a bare hostname (no scheme, no credentials, no database) is rejected with a clear message', async () => {
  await assert.rejects(
    () => ensureDatabaseExists('khaadsetu.cylskc8umprm.us-east-1.rds.amazonaws.com'),
    /full form postgres:\/\//,
  );
});

test('a URL with no database name in the path is rejected with a clear message', async () => {
  await assert.rejects(() => ensureDatabaseExists('postgres://user:pass@localhost:5432/'), /has no database name/);
});

test('does nothing when DATABASE_URL already points at the bootstrap database', async () => {
  // Must not try to "create postgres" or otherwise touch it.
  await ensureDatabaseExists(urlFor('postgres'));
});
