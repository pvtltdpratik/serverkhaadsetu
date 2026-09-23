const config = require('./config');
const { ensureDatabaseExists } = require('./db/bootstrap');
const { createDb } = require('./db/database');
const { seedIfEmpty } = require('./db/seed');
const { createApp } = require('./app');
const { runReservationMaintenance } = require('./services/reservationJobs');

const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

const main = async () => {
  if (!config.databaseUrl) {
    console.error('DATABASE_URL is not set. Point it at a Postgres database, e.g. postgres://user:pass@localhost:5432/khaadsetu');
    process.exit(1);
  }
  await ensureDatabaseExists(config.databaseUrl, { ssl: config.databaseSsl, bootstrapDb: config.databaseBootstrapDb });
  const db = createDb({ url: config.databaseUrl, ssl: config.databaseSsl });
  await db.migrate();
  await seedIfEmpty(db);

  const app = createApp(db);
  const server = app.listen(config.port, () => console.log(`API server listening on port ${config.port}`));

  // Expire overdue reservations and send day-3 / day-5 reminders. Safe on every
  // instance: the job takes an advisory lock so only one does the work.
  const maintain = () => runReservationMaintenance(db)
    .then((r) => { if (r.expired || r.reminded) console.log(`Reservations: ${r.expired} expired, ${r.reminded} reminded`); })
    .catch((err) => console.error('Reservation maintenance failed:', err.message));
  maintain();
  const timer = setInterval(maintain, MAINTENANCE_INTERVAL_MS);
  timer.unref();

  // Let in-flight requests finish and return connections before exiting.
  const stop = () => {
    clearInterval(timer);
    server.close(() => db.close().then(() => process.exit(0)));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
};

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
