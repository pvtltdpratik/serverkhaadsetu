const { Client } = require('pg');

// A freshly created RDS instance only has its built-in maintenance database
// ("postgres") — the app's own database ("khaadsetu") does not exist yet, and
// Postgres has no `CREATE DATABASE IF NOT EXISTS` and no way to switch
// databases on an existing connection. So before the app can connect to
// DATABASE_URL's database, it has to open a *separate* connection to the
// bootstrap database on the same server, check whether the target database
// exists, and create it there if not.
//
// Safe to call every start: once the database exists this is a single
// read-only query.
const ensureDatabaseExists = async (url, { ssl, bootstrapDb = 'postgres' } = {}) => {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Error(
      `DATABASE_URL is not a valid connection URL: "${url}". ` +
        'It needs the full form postgres://<user>:<password>@<host>:<port>/<database> — ' +
        'an RDS endpoint by itself (e.g. "khaadsetu.xxxxx.rds.amazonaws.com") is only the host part.',
    );
  }
  if (!/^postgres(ql)?:$/.test(target.protocol)) {
    throw new Error(`DATABASE_URL must start with postgres:// or postgresql://, got "${target.protocol}//"`);
  }
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!dbName) {
    throw new Error(`DATABASE_URL has no database name after the host (postgres://user:pass@host:5432/khaadsetu): "${url}"`);
  }
  if (dbName === bootstrapDb) return; // already pointed at the bootstrap database itself

  const adminUrl = new URL(url);
  adminUrl.pathname = `/${bootstrapDb}`;

  const client = new Client({ connectionString: adminUrl.toString(), ssl: ssl ? { rejectUnauthorized: false } : undefined });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Could not connect to the "${bootstrapDb}" database on this Postgres server to check for "${dbName}" (${err.message}). ` +
        'Check the host, port, username and password in DATABASE_URL, and that the RDS security group allows this machine.',
    );
  }
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rowCount > 0) return;
    try {
      // A database name is an identifier, not a value, so it cannot be
      // parameterised — quoted so any name Postgres accepts round-trips safely.
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`Created database "${dbName}".`);
    } catch (err) {
      // Another instance created it between our check and our CREATE, which
      // is fine either way it surfaces: 42P04 (duplicate_database) is the
      // normal case, but CREATE DATABASE isn't MVCC-safe, so a genuine race
      // can instead hit the catalog's unique index directly (23505).
      if (err.code !== '42P04' && err.code !== '23505') throw err;
    }
  } finally {
    await client.end();
  }
};

module.exports = { ensureDatabaseExists };
