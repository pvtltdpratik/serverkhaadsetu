// Applies pending migrations (and loads the starter data into an empty
// database) without starting the server:  npm run migrate
const config = require('../src/config');
const { ensureDatabaseExists } = require('../src/db/bootstrap');
const { createDb } = require('../src/db/database');
const { seedIfEmpty } = require('../src/db/seed');

(async () => {
  if (!config.databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  await ensureDatabaseExists(config.databaseUrl, { ssl: config.databaseSsl, bootstrapDb: config.databaseBootstrapDb });
  const db = createDb({ url: config.databaseUrl, ssl: config.databaseSsl });
  await db.migrate();
  await seedIfEmpty(db);
  await db.close();
  console.log('Database is up to date.');
})().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
