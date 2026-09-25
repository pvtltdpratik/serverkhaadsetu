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
  // Home delivery by farmers with vehicles. The fee is base + per km (by road) +
  // per 10 kg above the first 10, rounded up to the next Rs 5, never below minFee.
  delivery: {
    baseFee: Number(process.env.DELIVERY_BASE_FEE) || 25,
    perKm: Number(process.env.DELIVERY_PER_KM) || 4,
    per10Kg: Number(process.env.DELIVERY_PER_10KG) || 2,
    minFee: Number(process.env.DELIVERY_MIN_FEE) || 30,
    // Farthest a delivery goes, by road, from the center to the farm.
    maxRoadKm: Number(process.env.DELIVERY_MAX_KM) || 20,
    // Offers go to this many nearby partners at a time, each open for this long.
    offersPerRound: Number(process.env.DELIVERY_OFFERS_PER_ROUND) || 3,
    offerMinutes: Number(process.env.DELIVERY_OFFER_MINUTES) || 4,
    // After this long with nobody, the order goes back to plain pickup.
    searchMinutes: Number(process.env.DELIVERY_SEARCH_MINUTES) || 45,
    // How many jobs one partner may carry at once (batching). The loads must also fit his vehicle together.
    maxActiveJobs: Number(process.env.DELIVERY_MAX_ACTIVE_JOBS) || 3,
    // Two drops count as "the same trip" when they are this close (straight line, km).
    batchKm: Number(process.env.DELIVERY_BATCH_KM) || 4,
    // A trip serves a job whose pickup and drop are each within this of the trip's ends.
    tripMatchKm: Number(process.env.DELIVERY_TRIP_MATCH_KM) || 8,
    // Most farmer-to-farmer requests one person may have open at once.
    maxOpenP2p: Number(process.env.DELIVERY_MAX_OPEN_P2P) || 5,
  },
  // Razorpay online payments. The SECRET is read only here, from the environment, and is never sent to
  // the app or written to git. Leave the key id empty to switch online payment off.
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },
  // The farming assistant (Google Gemini). The key is read only here, from the environment, and is never
  // sent to the app or written to git. Leave it empty to switch the assistant off.
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    // Tried when the main model is busy.
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.8-flash',
  },
  corsOrigin: process.env.CORS_ORIGIN || '*',
};
