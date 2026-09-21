const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// node-pg returns numeric (money, hectares) and int8 (counts) as strings to
// avoid precision loss. Our values are small, and the API sends JSON numbers.
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => parseInt(v, 10));

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

// A thin wrapper over a pg Pool. `schema` puts everything in a named schema
// (used by tests so each test file gets an isolated copy of the tables).
class Database {
  constructor({ url, schema, ssl }) {
    this.schema = schema || null;
    this.pool = new Pool({
      connectionString: url,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
      max: 10,
      // Every connection resolves unqualified table names in our schema.
      options: schema ? `-c search_path=${schema}` : undefined,
    });
    // An idle client dying (e.g. the server restarting) must not crash the process.
    this.pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  }

  query(text, params) {
    return this.pool.query(text, params);
  }

  // Rows only — the common case.
  async rows(text, params) {
    return (await this.pool.query(text, params)).rows;
  }

  async one(text, params) {
    return (await this.pool.query(text, params)).rows[0];
  }

  // Runs `fn(client)` in a transaction; `client.query` has the same shape.
  async tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Applies migrations/*.sql that have not run yet, in filename order. Safe to
  // call on every start and from several instances at once (advisory lock).
  async migrate() {
    if (this.schema) await this.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await this.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(727201)');
      await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      for (const file of files) {
        if (done.has(file)) continue;
        await c.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      }
    });
  }

  async dropSchema() {
    if (this.schema) await this.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
  }

  close() {
    return this.pool.end();
  }
}

const createDb = (options) => new Database(options);

module.exports = { createDb };
