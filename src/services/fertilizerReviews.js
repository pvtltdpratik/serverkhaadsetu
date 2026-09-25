const crypto = require('crypto');
const { HttpError } = require('../utils/http');
const { notify } = require('./notifications');
const crops = require('../data/cropReference');
const { seasonOf } = require('./resale');

// The three-phase fertilizer log. See migration 017 for the shape of the data.

const MID_MIN_DAYS = Number(process.env.REVIEW_MID_MIN_DAYS) || 28;       // phase 2 opens 4 weeks after phase 1
const HARVEST_MIN_DAYS = Number(process.env.REVIEW_HARVEST_MIN_DAYS) || 45; // phase 3 needs a growing season
const PHASE1_COUPON_PERCENT = 5;
const CHAMPION_COUPON_PERCENT = 10;
const COINS = { mid: 10, post: 50 };
const COIN_BATCH = 100;   // coins are redeemed in hundreds ...
const COIN_RUPEES = 25;   // ... and 100 coins are worth Rs 25 in the wallet
const OUTLIER = { maxGainPct: 80, minGainPct: -50, maxTimesDistrictAvg: 3 };
const PRIORITY_DAYS = 180;
const COUPON_DAYS = 90;
const DAY = 24 * 3600 * 1000;

const SOILS = ['black', 'red', 'alluvial', 'laterite', 'sandy', 'other'];
const STAGES = ['sowing', 'vegetative', 'flowering', 'pod_filling'];
const METHODS = ['broadcasting', 'banding', 'foliar_spray', 'drip'];
const REASONS = ['app_recommendation', 'operator_suggested', 'seen_in_community', 'used_before'];
const IRRIGATION = ['rainfed', 'well', 'borewell', 'canal', 'drip', 'sprinkler'];
const MID_CHANGES = ['improved', 'no_change', 'worsened'];
const LEAF = ['greener', 'same', 'yellowing'];
const SOIL_FEEL = ['better', 'same', 'worse'];
const USE_AGAIN = ['yes', 'no', 'maybe'];

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

// ---- pure rules --------------------------------------------------------------------------------

const sizeClass = (acres) => (acres < 2 ? 'small' : acres <= 5 ? 'medium' : 'large');
const levelOf = (value) => (value < 40 ? 'low' : value < 70 ? 'medium' : 'high');

// Kharif and Rabi in order, so "three seasons running" can be counted. Zaid is a short optional season.
const seasonNumber = (season) => {
  const [name, year] = season.split('-');
  if (name === 'kharif') return Number(year) * 2;
  if (name === 'rabi') return Number(year) * 2 + 1;
  return null;
};

// The longest run of consecutive Kharif/Rabi seasons ending at the latest completed one.
const currentStreak = (seasons) => {
  const numbers = [...new Set(seasons.map(seasonNumber).filter((n) => n !== null))].sort((a, b) => a - b);
  let streak = 0;
  for (let i = numbers.length - 1; i >= 0; i -= 1) {
    if (i === numbers.length - 1 || numbers[i + 1] - numbers[i] === 1) streak += 1;
    else break;
  }
  return streak;
};

// How far above (or below) the reference yield this one is. The baseline is the farmer's own last season when they
// gave it, else the district average.
const improvement = ({ yieldQpa, lastSeasonQpa, districtAvgQpa }) => {
  const baseline = lastSeasonQpa || districtAvgQpa || null;
  if (!baseline) return { baseline: null, pct: null };
  return { baseline, pct: round1(((yieldQpa - baseline) / baseline) * 100) };
};

// A result outside the normal range is held for an agronomist rather than published straight away.
const outlierReason = ({ pct, yieldQpa, districtAvgQpa }) => {
  if (pct !== null && pct > OUTLIER.maxGainPct) return `Yield ${pct}% above the reference, more than the usual range`;
  if (pct !== null && pct < OUTLIER.minGainPct) return `Yield ${Math.abs(pct)}% below the reference, a very poor result`;
  if (districtAvgQpa && yieldQpa > districtAvgQpa * OUTLIER.maxTimesDistrictAvg) return 'Yield is more than three times the district average';
  return '';
};

const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---- context -----------------------------------------------------------------------------------

const latestScan = async (q, owner, after = null) => {
  const { rows } = await q.query(
    `SELECT id, created_at, health_score, nutrient_n, nutrient_p, nutrient_k FROM scans WHERE owner_id = $1 ${after ? 'AND created_at > $2' : ''} ORDER BY created_at DESC LIMIT 1`,
    after ? [owner, after] : [owner],
  );
  const s = rows[0];
  if (!s) return null;
  return {
    id: s.id,
    score: Math.round(s.health_score),
    npk: { n: levelOf(s.nutrient_n), p: levelOf(s.nutrient_p), k: levelOf(s.nutrient_k), nValue: Math.round(s.nutrient_n), pValue: Math.round(s.nutrient_p), kValue: Math.round(s.nutrient_k) },
  };
};

const farmFacts = async (q, owner) => {
  const details = (await q.query('SELECT data FROM farmer_details WHERE owner_id = $1', [owner])).rows[0]?.data || {};
  const profile = (await q.query('SELECT name, land_holding_hectares AS land FROM profiles WHERE owner_id = $1', [owner])).rows[0];
  const address = (await q.query('SELECT district FROM farmer_address WHERE owner_id = $1 ORDER BY is_default DESC, created_at DESC LIMIT 1', [owner])).rows[0];
  const center = (await q.query('SELECT c.district FROM profiles p JOIN village_center c ON c.center_id = p.home_center_id WHERE p.owner_id = $1', [owner])).rows[0];
  return {
    soilType: details.soilType || null,
    irrigation: details.irrigation || null,
    crops: details.primaryCrops || [],
    acres: profile && Number(profile.land) > 0 ? round1(Number(profile.land) * 2.471) : null,
    district: (address && address.district) || (center && center.district) || '',
    name: profile && profile.name && profile.name !== 'Farmer' ? profile.name : 'Farmer',
  };
};

// Products this farmer collected and may log, with what is already logged for them.
const eligibleProducts = async (db, owner, now = new Date()) => {
  const { rows } = await db.query(
    `SELECT p.id AS "productId", p.name, p.brand, p.unit_label AS "unit", p.category, sum(i.quantity)::int AS purchased,
            (array_agg(o.id ORDER BY o.created_at DESC))[1] AS "orderId", max(o.created_at) AS "lastBought"
       FROM orders o JOIN order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id
      WHERE o.owner_id = $1 AND o.status = 'completed' AND i.surplus_lot_id IS NULL AND p.category IN ('organic','fertilizer')
      GROUP BY p.id ORDER BY max(o.created_at) DESC`, [owner],
  );
  const logged = (await db.query('SELECT product_id AS "productId", review_id AS "reviewId", crop, season, status FROM fertilizer_review WHERE owner_id = $1 ORDER BY created_at DESC', [owner])).rows;
  return rows.map((r) => ({ ...r, season: seasonOf(now), logs: logged.filter((l) => l.productId === r.productId) }));
};

const prefill = async (db, owner, productId, now = new Date()) => {
  const eligible = (await eligibleProducts(db, owner, now)).find((e) => e.productId === productId);
  const facts = await farmFacts(db, owner);
  const scan = await latestScan(db, owner);
  return { eligible: Boolean(eligible), orderId: eligible ? eligible.orderId : null, season: seasonOf(now), ...facts, scan, cropNames: crops.list().map((c) => c.name) };
};

// ---- rewards -----------------------------------------------------------------------------------

const newId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

const grantCoins = async (c, owner, amount, refId, note) => {
  await c.query('INSERT INTO farmer_reward (reward_id, owner_id, kind, amount, ref_id, note) VALUES ($1,$2,$3,$4,$5,$6)', [newId('rw'), owner, 'coins', amount, refId, note]);
};

// True when the badge was new.
const grantBadge = async (c, owner, badge, refId, note) => {
  const { rowCount } = await c.query(
    "INSERT INTO farmer_reward (reward_id, owner_id, kind, badge, ref_id, note) VALUES ($1,$2,'badge',$3,$4,$5) ON CONFLICT DO NOTHING", [newId('rw'), owner, badge, refId, note],
  );
  return rowCount > 0;
};

const issueCoupon = async (c, owner, percent, source, now = new Date()) => {
  const code = `SAMRUDHI-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  await c.query('INSERT INTO farmer_coupon (code, owner_id, percent, source, expires_at) VALUES ($1,$2,$3,$4,$5)', [code, owner, percent, source, new Date(now.getTime() + COUPON_DAYS * DAY)]);
  return code;
};

const rewardsOf = async (db, owner, now = new Date()) => {
  const coins = (await db.query("SELECT COALESCE(SUM(amount), 0)::int AS n FROM farmer_reward WHERE owner_id = $1 AND kind = 'coins'", [owner])).rows[0].n;
  const badges = (await db.query("SELECT badge, note, created_at AS \"earnedAt\" FROM farmer_reward WHERE owner_id = $1 AND kind = 'badge' ORDER BY created_at", [owner])).rows;
  const priority = (await db.query("SELECT max(until) AS until FROM farmer_reward WHERE owner_id = $1 AND kind = 'priority'", [owner])).rows[0].until;
  const coupons = (await db.query(
    `SELECT code, percent::float8 AS percent, source, expires_at AS "expiresAt", (used_order_id IS NOT NULL) AS used
       FROM farmer_coupon WHERE owner_id = $1 ORDER BY created_at DESC`, [owner],
  )).rows.map((k) => ({ ...k, expired: new Date(k.expiresAt) <= now }));
  const seasons = (await db.query('SELECT DISTINCT season FROM fertilizer_review WHERE owner_id = $1 AND phase3_at IS NOT NULL', [owner])).rows.map((r) => r.season);
  return {
    coins, coinBatch: COIN_BATCH, coinBatchRupees: COIN_RUPEES, badges,
    priorityUntil: priority && new Date(priority) > now ? priority : null,
    coupons, streak: currentStreak(seasons), completedSeasons: seasons.length,
  };
};

const redeemCoins = async (db, owner, coins) => {
  if (coins < COIN_BATCH || coins % COIN_BATCH !== 0) throw new HttpError(400, `Coins are redeemed in multiples of ${COIN_BATCH}`);
  return db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`coins:${owner}`]);
    const have = (await c.query("SELECT COALESCE(SUM(amount), 0)::int AS n FROM farmer_reward WHERE owner_id = $1 AND kind = 'coins'", [owner])).rows[0].n;
    if (have < coins) throw new HttpError(409, `You have ${have} coins, not ${coins}`);
    const rupees = (coins / COIN_BATCH) * COIN_RUPEES;
    await c.query("INSERT INTO farmer_reward (reward_id, owner_id, kind, amount, note) VALUES ($1,$2,'coins',$3,'Redeemed for wallet money')", [newId('rw'), owner, -coins]);
    await require('./wallet').addEntry(c, owner, rupees, 'coin_redemption', null, `${coins} coins`);
    return { redeemed: coins, rupees, coins: have - coins };
  });
};

// ---- the three phases --------------------------------------------------------------------------

const getReview = async (q, id) => {
  const { rows } = await q.query('SELECT * FROM fertilizer_review WHERE review_id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'Review not found');
  return rows[0];
};

const mineOrThrow = async (q, owner, id) => {
  const r = await getReview(q, id);
  if (r.owner_id !== owner) throw new HttpError(404, 'Review not found');
  return r;
};

const daysSince = (date, now) => (now.getTime() - new Date(date).getTime()) / DAY;

// What the farmer sees of their own log: where it stands and when the next step opens.
const mineShape = (r, product, now = new Date()) => {
  const since = daysSince(r.phase1_at, now);
  const done = r.phase3_at !== null;
  return {
    reviewId: r.review_id, productId: r.product_id, productName: product ? product.name : undefined, crop: r.crop, variety: r.variety, season: r.season, status: r.status,
    acres: Number(r.acres), soilType: r.soil_type, appliedOn: r.applied_on instanceof Date ? r.applied_on.toISOString().slice(0, 10) : r.applied_on,
    phase: done ? 3 : r.phase2_at ? 2 : 1,
    midOpensInDays: done || r.phase2_at ? 0 : Math.max(Math.ceil(MID_MIN_DAYS - since), 0),
    harvestOpensInDays: done ? 0 : Math.max(Math.ceil(HARVEST_MIN_DAYS - since), 0),
    yieldQpa: r.yield_qpa == null ? null : Number(r.yield_qpa), improvementPct: r.improvement_pct == null ? null : Number(r.improvement_pct),
    flagReason: r.flag_reason, agronomistReviewed: r.agronomist_reviewed, featured: r.featured, createdAt: r.created_at,
  };
};

const startPhase1 = async (db, { owner, productId, input, now = new Date() }) =>
  db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`review:${owner}`]);
    const eligible = (await eligibleProducts(c, owner, now)).find((e) => e.productId === productId);
    if (!eligible) throw new HttpError(409, 'You can log a fertilizer you bought here and collected from a village center');
    const facts = await farmFacts(c, owner);
    const soilType = facts.soilType;
    if (!soilType) throw new HttpError(409, 'Add your soil type under Farm & scheme details first: reviews use your own farm profile, so nobody can invent it');
    if (!crops.lookup(input.crop)) throw new HttpError(400, `Choose a crop from the list: ${crops.list().map((k) => k.name).join(', ')}`);
    const crop = crops.lookup(input.crop).name;
    const season = seasonOf(now);
    const existing = (await c.query('SELECT review_id FROM fertilizer_review WHERE owner_id = $1 AND product_id = $2 AND season = $3 AND crop = $4', [owner, productId, season, crop])).rows[0];
    if (existing) throw new HttpError(409, `You have already logged this fertilizer for ${crop} this season`);

    const scan = await latestScan(c, owner);
    const irrigation = input.irrigation || facts.irrigation;
    if (!irrigation) throw new HttpError(400, 'Say how the field is irrigated');
    const id = newId('frev');
    await c.query(
      `INSERT INTO fertilizer_review (review_id, owner_id, product_id, order_id, season, acres, soil_type, crop, variety, growth_stage, irrigation, qty_per_acre, unit_label,
                                     method, reason, district, size_class, npk_before, score_before, applied_on, phase1_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21)`,
      [id, owner, productId, eligible.orderId, season, input.acres, soilType, crop, input.variety || '', input.growthStage, irrigation, input.qtyPerAcre, eligible.unit,
        input.method, input.reason, facts.district, sizeClass(input.acres), scan ? JSON.stringify(scan.npk) : null, scan ? scan.score : null, input.appliedOn, now],
    );
    const coupon = await issueCoupon(c, owner, PHASE1_COUPON_PERCENT, `Baseline logged for ${crop}`, now);
    await notify(c, owner, {
      type: 'order', title: 'Baseline saved: 5% off your next order',
      body: `Use coupon ${coupon} on your next order. In about ${MID_MIN_DAYS / 7} weeks we will ask how your ${crop} looks.`, refId: id,
    });
    return { review: mineShape(await getReview(c, id), { name: eligible.name }, now), coupon: { code: coupon, percent: PHASE1_COUPON_PERCENT } };
  });

const submitMid = async (db, { owner, id, input, now = new Date() }) =>
  db.tx(async (c) => {
    const r = await mineOrThrow(c, owner, id);
    if (r.phase2_at) throw new HttpError(409, 'You already sent your mid-season notes');
    if (r.phase3_at) throw new HttpError(409, 'This log is already finished');
    const days = daysSince(r.phase1_at, now);
    if (days < MID_MIN_DAYS) throw new HttpError(409, `Mid-season notes open ${Math.ceil(MID_MIN_DAYS - days)} days from now, about 4 weeks after you applied it`);
    await c.query("UPDATE fertilizer_review SET mid = $2::jsonb, phase2_at = $3, status = 'phase2' WHERE review_id = $1", [id, JSON.stringify(input), now]);
    await grantCoins(c, owner, COINS.mid, id, 'Mid-season notes');
    await notify(c, owner, { type: 'order', title: `You earned ${COINS.mid} coins`, body: 'Thank you for the mid-season notes. They help farmers with the same soil and crop.', refId: id });
    return { review: mineShape(await getReview(c, id), null, now), coins: COINS.mid };
  });

const submitPost = async (db, { owner, id, input, now = new Date() }) =>
  db.tx(async (c) => {
    const r = await mineOrThrow(c, owner, id);
    if (r.phase3_at) throw new HttpError(409, 'You already logged the harvest for this');
    // Phase 1 must come first, and a growing season must have passed: the before and after have to be real.
    const days = daysSince(r.phase1_at, now);
    if (days < HARVEST_MIN_DAYS) throw new HttpError(409, `The harvest can be logged ${Math.ceil(HARVEST_MIN_DAYS - days)} days from now: it needs a growing season after you applied the fertilizer`);

    const ref = crops.lookup(r.crop);
    const districtAvg = ref ? ref.districtAvgQpa : null;
    const { baseline, pct } = improvement({ yieldQpa: input.yieldQpa, lastSeasonQpa: input.lastSeasonQpa, districtAvgQpa: districtAvg });
    const flag = outlierReason({ pct, yieldQpa: input.yieldQpa, districtAvgQpa: districtAvg });
    const after = await latestScan(c, owner, r.phase1_at);
    const status = flag ? 'flagged' : 'published';
    await c.query(
      `UPDATE fertilizer_review SET yield_qpa = $2, last_season_qpa = $3, district_avg_qpa = $4, baseline_qpa = $5, improvement_pct = $6, score_after = $7, npk_after = $8::jsonb,
              stars_overall = $9, stars_value = $10, stars_ease = $11, use_again = $12, recommend = $13, comment = $14, phase3_at = $15, status = $16, flag_reason = $17
        WHERE review_id = $1`,
      [id, input.yieldQpa, input.lastSeasonQpa || null, districtAvg, baseline, pct, after ? after.score : null, after ? JSON.stringify(after.npk) : null,
        input.starsOverall, input.starsValue, input.starsEase, input.useAgain, input.recommend, input.comment || '', now, status, flag],
    );

    // What the farmer earns for finishing the log.
    await grantCoins(c, owner, COINS.post, id, 'Harvest logged');
    await c.query("INSERT INTO farmer_reward (reward_id, owner_id, kind, note, until) VALUES ($1,$2,'priority','Priority access to next season''s recommendations',$3)", [newId('rw'), owner, new Date(now.getTime() + PRIORITY_DAYS * DAY)]);
    const earned = [`${COINS.post} coins`, 'priority access to next season\'s recommendations'];
    if (await grantBadge(c, owner, 'verified_farmer', id, 'Completed a full season log')) earned.push('the Verified Farmer badge');

    const seasons = (await c.query('SELECT DISTINCT season FROM fertilizer_review WHERE owner_id = $1 AND phase3_at IS NOT NULL', [owner])).rows.map((x) => x.season);
    const streak = currentStreak(seasons);
    let championCoupon = null;
    if (streak >= 3 && await grantBadge(c, owner, 'champion_farmer', id, 'Three seasons in a row')) {
      championCoupon = await issueCoupon(c, owner, CHAMPION_COUPON_PERCENT, 'Champion Farmer', now);
      earned.push('the Champion Farmer badge', `a ${CHAMPION_COUPON_PERCENT}% coupon (${championCoupon})`);
    }
    await notify(c, owner, {
      type: 'order', title: flag ? 'Thank you: an agronomist will check your result' : 'Your harvest log is published',
      body: `You earned ${earned.join(', ')}.${flag ? ' Unusual results are checked by an agronomist before they are shown to other farmers.' : ''}`, refId: id,
    });
    return { review: mineShape(await getReview(c, id), null, now), earned, streak, championCoupon, improvementPct: pct, districtAvgQpa: districtAvg };
  });

const savePhoto = async (db, { owner, id, kind, buffer }) => {
  if (!['mid', 'harvest'].includes(kind)) throw new HttpError(404, 'Photo kind must be mid or harvest');
  const r = await mineOrThrow(db, owner, id);
  const contentType = await require('./resale').detectPhoto(buffer);
  if (kind === 'harvest' && r.phase3_at) throw new HttpError(409, 'Add the harvest photo when you log the harvest');
  await db.query(
    `INSERT INTO review_photo (review_id, kind, content_type, data) VALUES ($1,$2,$3,$4)
     ON CONFLICT (review_id, kind) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, uploaded_at = now()`, [id, kind, contentType, buffer],
  );
  return { ok: true };
};

const readPhoto = async (q, id, kind) => {
  const { rows } = await q.query('SELECT content_type AS "contentType", data FROM review_photo WHERE review_id = $1 AND kind = $2', [id, kind]);
  if (!rows.length) throw new HttpError(404, 'That photo was not uploaded');
  return rows[0];
};

const listMine = async (db, owner, now = new Date()) => {
  const { rows } = await db.query(
    'SELECT r.*, p.name AS product_name FROM fertilizer_review r JOIN products p ON p.id = r.product_id WHERE r.owner_id = $1 ORDER BY r.created_at DESC', [owner],
  );
  return rows.map((r) => mineShape(r, { name: r.product_name }, now));
};

// ---- what other farmers see --------------------------------------------------------------------

const FILTERS = (f) => {
  const where = ["r.product_id = $1", "r.status = 'published'"];
  const params = [f.productId];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.soil) add('r.soil_type = ?', f.soil);
  if (f.crop) add('lower(r.crop) = lower(?)', f.crop);
  if (f.district) add('lower(r.district) = lower(?)', f.district);
  if (f.season) add('r.season LIKE ?', `${f.season}-%`);
  if (f.size) add('r.size_class = ?', f.size);
  if (f.improved) where.push('r.improvement_pct > 0');
  return { where: where.join(' AND '), params };
};

const card = (r) => ({
  reviewId: r.review_id,
  farmer: `${String(r.farmer_name || 'Farmer').split(' ')[0]}${r.district ? ` from ${r.district}` : ''}`,
  crop: r.crop, variety: r.variety, soilType: r.soil_type, acres: Number(r.acres), sizeClass: r.size_class, irrigation: r.irrigation, season: r.season,
  npkBefore: r.npk_before, scoreBefore: r.score_before, qtyPerAcre: Number(r.qty_per_acre), unit: r.unit_label, growthStage: r.growth_stage, method: r.method,
  yieldQpa: r.yield_qpa == null ? null : Number(r.yield_qpa), lastSeasonQpa: r.last_season_qpa == null ? null : Number(r.last_season_qpa),
  districtAvgQpa: r.district_avg_qpa == null ? null : Number(r.district_avg_qpa), improvementPct: r.improvement_pct == null ? null : Number(r.improvement_pct),
  scoreAfter: r.score_after, npkAfter: r.npk_after, starsOverall: r.stars_overall, starsValue: r.stars_value, starsEase: r.stars_ease, useAgain: r.use_again,
  comment: r.comment, mid: r.mid, hasMidPhoto: Number(r.mid_photos) > 0, hasHarvestPhoto: Number(r.harvest_photos) > 0,
  verifiedPurchase: true, agronomistReviewed: r.agronomist_reviewed, featured: r.featured, createdAt: r.phase3_at,
});

const publishedRows = async (db, filters) => {
  const { where, params } = FILTERS(filters);
  return (await db.query(
    `SELECT r.*, COALESCE(NULLIF(p.name, ''), 'Farmer') AS farmer_name,
            (SELECT count(*) FROM review_photo ph WHERE ph.review_id = r.review_id AND ph.kind = 'mid') AS mid_photos,
            (SELECT count(*) FROM review_photo ph WHERE ph.review_id = r.review_id AND ph.kind = 'harvest') AS harvest_photos
       FROM fertilizer_review r LEFT JOIN profiles p ON p.owner_id = r.owner_id WHERE ${where} ORDER BY r.featured DESC, r.agronomist_reviewed DESC, r.phase3_at DESC`, params,
  )).rows;
};

// The aggregated card at the top of a product's reviews: worked out from the data, never written by hand.
const summarize = (rows) => {
  const n = rows.length;
  if (!n) return { count: 0, overall: null, improvementAvg: null, best: null, topRatedFor: [], watchOutFor: [] };
  const avg = (key) => mean(rows.map((r) => r[key]).filter((v) => v != null).map(Number));
  const gains = rows.map((r) => (r.improvement_pct == null ? null : Number(r.improvement_pct))).filter((v) => v !== null);
  const overallGain = mean(gains);

  const groups = new Map();
  for (const r of rows) {
    if (r.improvement_pct == null) continue;
    const key = `${r.soil_type}|${r.crop}|${r.season.split('-')[0]}`;
    groups.set(key, [...(groups.get(key) || []), Number(r.improvement_pct)]);
  }
  let best = null;
  for (const [key, list] of groups) {
    if (list.length < 2 && n > 3) continue;
    const m = mean(list);
    if (!best || m > best.averagePct) {
      const [soil, crop, season] = key.split('|');
      best = { soil, crop, season, averagePct: round1(m), reviews: list.length };
    }
  }

  const top = [];
  if ((avg('stars_value') || 0) >= 4) top.push('Value for money');
  if ((avg('stars_ease') || 0) >= 4) top.push('Easy to apply');
  const lowOf = { n: 'Nitrogen', p: 'Phosphorus', k: 'Potassium' };
  for (const [k, label] of Object.entries(lowOf)) {
    const g = rows.filter((r) => r.npk_before && r.npk_before[k] === 'low' && r.improvement_pct != null).map((r) => Number(r.improvement_pct));
    if (g.length >= 2 && mean(g) >= 10) top.push(`${label} deficiency correction`);
  }

  const watch = [];
  if (overallGain !== null) {
    const bySoil = new Map();
    for (const r of rows) if (r.improvement_pct != null) bySoil.set(r.soil_type, [...(bySoil.get(r.soil_type) || []), Number(r.improvement_pct)]);
    for (const [soil, list] of bySoil) if (list.length >= 2 && mean(list) <= overallGain - 8) watch.push(`Less effective on ${soil} soil`);
    const rainfed = rows.filter((r) => r.irrigation === 'rainfed' && r.improvement_pct != null).map((r) => Number(r.improvement_pct));
    const watered = rows.filter((r) => r.irrigation !== 'rainfed' && r.improvement_pct != null).map((r) => Number(r.improvement_pct));
    if (rainfed.length >= 2 && watered.length >= 2 && mean(watered) - mean(rainfed) >= 8) watch.push('Needs good moisture at the time of application');
  }
  const wouldNot = rows.filter((r) => r.use_again === 'no').length;
  if (wouldNot / n >= 0.25) watch.push(`${Math.round((wouldNot / n) * 100)}% would not use it again`);

  return {
    count: n, overall: avg('stars_overall') == null ? null : round1(avg('stars_overall')), improvementAvg: overallGain == null ? null : round1(overallGain),
    best, topRatedFor: top, watchOutFor: watch,
  };
};

const forProduct = async (db, filters) => {
  const rows = await publishedRows(db, { ...filters, soil: undefined, crop: undefined, district: undefined, season: undefined, size: undefined, improved: undefined });
  const filtered = await publishedRows(db, filters);
  return { summary: summarize(rows), reviews: filtered.map(card), matching: filtered.length };
};

// "If you apply this to your 2-acre soybean farm, we expect ...": from real outcomes where there are enough of them,
// and from the nutrient the product supplies when there are not.
const predictYield = async (db, { owner, productId, acres, crop }) => {
  const ref = crops.lookup(crop);
  if (!ref) throw new HttpError(400, `Choose a crop from the list: ${crops.list().map((k) => k.name).join(', ')}`);
  const product = (await db.query('SELECT id, name, nutrient_focus AS focus FROM products WHERE id = $1', [productId])).rows[0];
  if (!product) throw new HttpError(404, 'Product not found');
  const facts = await farmFacts(db, owner);
  const scan = await latestScan(db, owner);

  const all = (await publishedRows(db, { productId })).filter((r) => r.improvement_pct != null && r.crop === ref.name);
  const sameSoil = facts.soilType ? all.filter((r) => r.soil_type === facts.soilType) : [];
  const pick = sameSoil.length >= 3 ? { rows: sameSoil, matched: 'your crop and soil type' } : all.length >= 3 ? { rows: all, matched: 'your crop' } : null;

  let lowPct;
  let highPct;
  let basis;
  let matched;
  let sampleSize = 0;
  if (pick) {
    const sorted = pick.rows.map((r) => Number(r.improvement_pct)).sort((a, b) => a - b);
    lowPct = Math.round(percentile(sorted, 0.25));
    highPct = Math.round(percentile(sorted, 0.75));
    basis = 'reviews';
    matched = pick.matched;
    sampleSize = sorted.length;
  } else {
    // Not enough farmers yet: use what the product supplies against what the soil scan found low.
    const focus = product.focus || [];
    const key = { nitrogen: 'n', phosphorus: 'p', potassium: 'k' };
    const levels = scan ? focus.map((f) => scan.npk[key[f]]).filter(Boolean) : [];
    [lowPct, highPct] = levels.includes('low') ? [12, 20] : levels.includes('medium') ? [6, 12] : [3, 8];
    basis = 'agronomy';
    matched = scan ? 'your soil scan' : 'general guidance (scan your soil for a better estimate)';
  }
  const baseline = ref.districtAvgQpa;
  const extra = (pct) => round1((baseline * acres * pct) / 100);
  const soilWords = facts.soilType ? `${facts.soilType}-soil ` : '';
  return {
    productId, crop: ref.name, acres, lowPct, highPct, basis, matched, sampleSize, baselineQpa: baseline,
    expectedExtraQuintals: { low: extra(lowPct), high: extra(highPct) },
    message: `On your ${acres}-acre ${soilWords}${ref.name.toLowerCase()} farm we expect ${lowPct}% to ${highPct}% more yield with ${product.name}.`,
    disclaimer: basis === 'reviews'
      ? `Based on ${sampleSize} farmers with ${matched}. Your result depends on rain, seed and how you apply it.`
      : 'An early estimate from how the product works, not from other farmers yet. It gets sharper as more farmers log their harvests.',
  };
};

// ---- the agronomist ---------------------------------------------------------------------------

const flagged = async (db) =>
  (await db.query(
    `SELECT r.review_id AS "reviewId", r.crop, r.soil_type AS "soilType", r.yield_qpa::float8 AS "yieldQpa", r.improvement_pct::float8 AS "improvementPct", r.flag_reason AS "flagReason",
            r.comment, p.name AS "productName", r.season, r.acres::float8 AS acres
       FROM fertilizer_review r JOIN products p ON p.id = r.product_id WHERE r.status = 'flagged' ORDER BY r.phase3_at`,
  )).rows;

const decide = async (db, { id, decision, note }) =>
  db.tx(async (c) => {
    const r = await getReview(c, id);
    if (r.status !== 'flagged') throw new HttpError(409, 'Only a held review can be decided');
    const status = decision === 'validate' ? 'published' : 'hidden';
    await c.query('UPDATE fertilizer_review SET status = $2, agronomist_reviewed = true, agronomist_note = $3 WHERE review_id = $1', [id, status, note || '']);
    await notify(c, r.owner_id, {
      type: 'order', title: decision === 'validate' ? 'Your harvest log was verified' : 'Your harvest log was not published',
      body: decision === 'validate' ? 'An agronomist checked your result. It now helps other farmers, with an Agronomist Reviewed badge.' : (note || 'An agronomist could not confirm the result, so it is not shown to other farmers.'), refId: id,
    });
    return { reviewId: id, status };
  });

const feature = async (db, { id }) =>
  db.tx(async (c) => {
    const r = await getReview(c, id);
    if (r.status !== 'published') throw new HttpError(409, 'Only a published review can be featured');
    await c.query('UPDATE fertilizer_review SET featured = true WHERE review_id = $1', [id]);
    await notify(c, r.owner_id, { type: 'order', title: 'Your story was featured', body: 'Your harvest is now a featured success story. A certificate is waiting for you at your village center.', refId: id });
    const center = (await c.query('SELECT c.operator_id FROM profiles p JOIN village_center c ON c.center_id = p.home_center_id WHERE p.owner_id = $1', [r.owner_id])).rows[0];
    if (center) await notify(c, center.operator_id, { type: 'order', title: 'Print a certificate', body: 'A farmer from your center was featured as a success story. Please give them their certificate.', refId: id });
    return { reviewId: id, featured: true };
  });

// Every finished, published review as one training record: what was known before (phase 1) and what happened (phase 3).
const trainingData = async (db) =>
  (await db.query(
    `SELECT r.review_id AS "reviewId", r.product_id AS "productId", r.season, r.crop, r.variety, r.soil_type AS "soilType", r.acres::float8 AS acres, r.irrigation,
            r.growth_stage AS "growthStage", r.qty_per_acre::float8 AS "qtyPerAcre", r.method, r.district, r.npk_before AS "npkBefore", r.score_before AS "scoreBefore",
            r.yield_qpa::float8 AS "yieldQpa", r.baseline_qpa::float8 AS "baselineQpa", r.improvement_pct::float8 AS "improvementPct", r.score_after AS "scoreAfter",
            r.npk_after AS "npkAfter", r.stars_overall AS "starsOverall", r.agronomist_reviewed AS "agronomistReviewed"
       FROM fertilizer_review r WHERE r.status = 'published' ORDER BY r.phase3_at`,
  )).rows;

// ---- coupons on orders -------------------------------------------------------------------------

// Checks a coupon for an order about to be placed. Returns the percent off, or throws.
const checkCoupon = async (c, owner, code, now = new Date()) => {
  const k = (await c.query('SELECT * FROM farmer_coupon WHERE code = $1 FOR UPDATE', [String(code).trim().toUpperCase()])).rows[0];
  if (!k || k.owner_id !== owner) throw new HttpError(404, 'That coupon was not found');
  if (k.used_order_id) throw new HttpError(409, 'That coupon was already used');
  if (new Date(k.expires_at) <= now) throw new HttpError(409, 'That coupon has expired');
  return { code: k.code, percent: Number(k.percent) };
};

const useCoupon = (c, code, orderId) => c.query('UPDATE farmer_coupon SET used_order_id = $2 WHERE code = $1', [code, orderId]);

// An order that did not go ahead gives its coupon back, if it has not expired.
const releaseCoupon = (c, orderId) => c.query('UPDATE farmer_coupon SET used_order_id = NULL WHERE used_order_id = $1', [orderId]);

module.exports = {
  MID_MIN_DAYS, HARVEST_MIN_DAYS, PHASE1_COUPON_PERCENT, CHAMPION_COUPON_PERCENT, COINS, COIN_BATCH, COIN_RUPEES, OUTLIER,
  SOILS, STAGES, METHODS, REASONS, IRRIGATION, MID_CHANGES, LEAF, SOIL_FEEL, USE_AGAIN,
  sizeClass, levelOf, currentStreak, improvement, outlierReason, percentile, summarize, seasonNumber,
  eligibleProducts, prefill, startPhase1, submitMid, submitPost, savePhoto, readPhoto, listMine, forProduct, predictYield,
  rewardsOf, redeemCoins, flagged, decide, feature, trainingData, checkCoupon, useCoupon, releaseCoupon, round1, round2,
};
