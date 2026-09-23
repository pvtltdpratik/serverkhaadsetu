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

// A real, decodable image: the analyzer runs in-process now, so it needs
// genuine bytes. `color` is [r, g, b].
const testImage = (color = [90, 160, 70], format = 'jpeg') =>
  require('sharp')({ create: { width: 64, height: 48, channels: 3, background: { r: color[0], g: color[1], b: color[2] } } })
    [format]()
    .toBuffer();
const testJpeg = testImage;

module.exports = { openTestDb, closeTestDb, testImage, testJpeg };
