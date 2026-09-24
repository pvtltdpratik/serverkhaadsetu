const config = require('./config');
const { ensureDatabaseExists } = require('./db/bootstrap');
const { createDb } = require('./db/database');
const { seedIfEmpty } = require('./db/seed');
const { createApp } = require('./app');
const { runReservationMaintenance } = require('./services/reservationJobs');
const { runReassignment } = require('./services/reassignment');
const { runDeliveryDispatch } = require('./services/deliveryJobs');

const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
// Delivery offers are only open for a few minutes, so they are checked far more often.
const DISPATCH_INTERVAL_MS = 30 * 1000;

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
    .catch((err) => console.error('Reservation maintenance failed:', err.message))
    .then(() => runReassignment(db, { timeZone: config.centerTimezone }))
    .then((r) => { if (r.moved || r.stuck) console.log(`Reassignment: ${r.moved} orders moved, ${r.stuck} with nowhere to go`); })
    .catch((err) => console.error('Order reassignment failed:', err.message));
  maintain();
  const timer = setInterval(maintain, MAINTENANCE_INTERVAL_MS);
  timer.unref();

  // Close unanswered delivery offers, ask the next partners, and put a delivery
  // nobody took back to plain pickup. Also safe on every instance (advisory lock).
  const dispatch = () => runDeliveryDispatch(db, { timeZone: config.centerTimezone })
    .then((r) => { if (r.offered || r.fellBack) console.log(`Deliveries: ${r.offered} offers sent, ${r.fellBack} fell back to pickup`); })
    .catch((err) => console.error('Delivery dispatch failed:', err.message));
  const dispatchTimer = setInterval(dispatch, DISPATCH_INTERVAL_MS);
  dispatchTimer.unref();

  // Let in-flight requests finish and return connections before exiting.
  const stop = () => {
    clearInterval(timer);
    clearInterval(dispatchTimer);
    server.close(() => db.close().then(() => process.exit(0)));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
};

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
