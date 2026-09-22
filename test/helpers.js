const { ensureDatabaseExists } = require('../src/db/bootstrap');
const { createDb } = require('../src/db/database');
const { seedIfEmpty } = require('../src/db/seed');

// Tests need a real Postgres (the SQL is the thing under test). Point
// TEST_DATABASE_URL at a throwaway database; each test file gets its own
// schema inside it, created fresh and dropped afterwards, so files can run in
// parallel without seeing each other's data.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/khaad_test';

const openTestDb = async (schema, { seed = true } = {}) => {
  const db = createDb({ url: TEST_DATABASE_URL, schema });
  try {
    await ensureDatabaseExists(TEST_DATABASE_URL);
    await db.dropSchema();
    await db.migrate();
    if (seed) await seedIfEmpty(db);
  } catch (err) {
    throw new Error(
      `Could not prepare the test database (${err.message}). Set TEST_DATABASE_URL to a Postgres database you can freely create schemas in.`,
    );
  }
  return db;
};

const closeTestDb = async (db) => {
  await db.dropSchema();
  await db.close();
};

module.exports = { openTestDb, closeTestDb };
