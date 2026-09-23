require('dotenv').config();

module.exports = {
  port: Number(process.env.PORT) || 3000,
  // When set, every /v1 request must carry a matching X-API-Key header.
  apiKey: process.env.API_KEY || '',
  // Postgres connection string, e.g. postgres://user:pass@host:5432/khaad_setu.
  databaseUrl: process.env.DATABASE_URL || '',
  // Set DATABASE_SSL=true for managed Postgres that requires TLS (RDS, Supabase, ...).
  databaseSsl: process.env.DATABASE_SSL === 'true',
  // The database every Postgres server already has, used to create
  // DATABASE_URL's database if it does not exist yet (see src/db/bootstrap.js).
  databaseBootstrapDb: process.env.DATABASE_BOOTSTRAP_DB || 'postgres',
  // Supabase project URL, e.g. https://xxxx.supabase.co. When set, every /v1
  // call must carry a valid Supabase access token and data is owned by the
  // token's user id. Empty = authentication off (anonymous X-Device-Id).
  supabaseUrl: process.env.SUPABASE_URL || '',
  // Comma-separated emails of platform administrators (matched against the
  // verified Supabase token's email). Nobody is an admin unless listed here.
  superAdminEmails: (process.env.SUPER_ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  // Centers' opening hours are judged on this clock, not the server's.
  centerTimezone: process.env.CENTER_TIMEZONE || 'Asia/Kolkata',
  commissionRatePercent: Number(process.env.COMMISSION_RATE_PERCENT) || 5,
  corsOrigin: process.env.CORS_ORIGIN || '*',
};
