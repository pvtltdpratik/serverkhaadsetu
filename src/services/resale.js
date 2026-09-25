const crypto = require('crypto');
const sharp = require('sharp');
const { HttpError } = require('../utils/http');
const { notify } = require('./notifications');
const wallet = require('./wallet');

// Farmers selling leftover ORGANIC fertilizer to other farmers, with the village center as the
// physical checkpoint. The rules below come from the resale flow the platform is built around.

const PRICE_MIN = 0.40;                 // a farmer may not price below 40% of the platform price ...
const PRICE_MAX = 0.90;                 // ... or above 90% of it
const CONDITION_FACTOR = { sealed: 0.85, opened: 0.70, clumped: 0.50 };
const MAX_LISTINGS_PER_SEASON = 3;      // the same product, by the same farmer, in one season
const HANDOVER_HOURS = 48;              // after a buyer is found, the seller has this long to bring it
const DISPUTE_HOURS = 48;               // a buyer may complain within this long of collecting
const NEIGHBOUR_AFTER_DAYS = 7;         // a listing shows to nearby centers only after this long
const OWN_AREA_KM = 10;                 // ... and to its own center's area before that
const CASH_KEEP = 0.97;                 // taking the payout as cash at the center keeps 97% of it
const QUALITY_PENALTY = 5;              // what an upheld dispute costs the approving center
const DAY = 24 * 3600 * 1000;

const CONDITIONS = ['sealed', 'opened', 'partially_used'];
const PAYOUT_MODES = ['wallet', 'upi', 'cash'];
const SEALS = ['sealed', 'opened_resealed', 'loose', 'damaged_packaging'];
const VISUALS = ['free_flowing', 'clumped', 'wet', 'clear', 'cloudy', 'separated'];
const LIVE_STATES = ['pending_verification', 'inspection_required', 'live', 'awaiting_handover', 'listed'];

const money = wallet.money;
const round1 = (n) => Math.round(n * 10) / 10;

// ---- pure rules --------------------------------------------------------------------------------

// Kharif June to October, Rabi November to March, Zaid April and May. A Rabi season that runs into
// January to March belongs to the year it began in.
const seasonOf = (date = new Date()) => {
  const m = date.getUTCMonth() + 1;
  const y = date.getUTCFullYear();
  if (m >= 6 && m <= 10) return `kharif-${y}`;
  if (m >= 11) return `rabi-${y}`;
  if (m <= 3) return `rabi-${y - 1}`;
  return `zaid-${y}`;
};

const monthsBetween = (from, to) => (to.getTime() - from.getTime()) / (30.4375 * DAY);

const ageFactor = (mfgDate, today = new Date()) => {
  if (!mfgDate) return 1;
  const months = monthsBetween(new Date(`${mfgDate}T00:00:00Z`), today);
  if (months < 6) return 1;
  if (months <= 12) return 0.9;
  return 0.75;
};

// Which of the three price bands the goods fall in, from what the seller said and what the
// operator saw: a clumped, cloudy or separated product is priced as such whatever the bag says.
const conditionBand = (condition, visual) => {
  if (['clumped', 'cloudy', 'separated'].includes(visual)) return 'clumped';
  return condition === 'sealed' ? 'sealed' : 'opened';
};

// The suggested resale price for one unit, and the range a farmer may choose from.
const priceGuide = ({ catalogPrice, condition, visual, mfgDate, today = new Date() }) => {
  const price = Number(catalogPrice);
  const band = conditionBand(condition, visual);
  const min = Math.ceil(price * PRICE_MIN);
  const max = Math.floor(price * PRICE_MAX);
  const raw = Math.round(price * CONDITION_FACTOR[band] * ageFactor(mfgDate, today));
  return {
    catalogPrice: price,
    suggested: Math.min(Math.max(raw, min), max),
    min,
    max,
    factors: { condition: CONDITION_FACTOR[band], age: ageFactor(mfgDate, today), band },
  };
};

// The commission split of a sale. A verified purchase that the center inspected: platform 8%, center
// 3%, seller 89%. Anything else (no proof of purchase, or a seller with no account): 10%, 4%, 86%.
// Taking the payout as cash keeps 97% of the seller's share; the wallet and UPI keep all of it.
const commission = ({ gross, verified, payoutMode }) => {
  const [platformPct, operatorPct] = verified ? [8, 3] : [10, 4];
  const platformFee = money(gross * platformPct / 100);
  const operatorCut = money(gross * operatorPct / 100);
  const share = money(gross - platformFee - operatorCut);
  const sellerNet = payoutMode === 'cash' ? money(share * CASH_KEEP) : share;
  return { platformPct, operatorPct, platformFee, operatorCut, share, sellerNet };
};

const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

// ---- reading -----------------------------------------------------------------------------------

const LISTING_COLUMNS = `r.id, r.seller_id AS "sellerId", r.seller_name AS "sellerName", r.seller_phone AS "sellerPhone", r.center_id AS "centerId",
  r.product_id AS "productId", p.name AS "productName", p.unit_label AS "unit", p.price_in_rupees AS "catalogPrice", r.channel, r.units,
  r.condition, to_char(r.mfg_date, 'YYYY-MM-DD') AS "mfgDate", to_char(r.expiry_date, 'YYYY-MM-DD') AS "expiryDate", r.batch_number AS "batchNumber",
  r.asking_price AS "askingPrice", r.suggested_price AS "suggestedPrice", r.final_price AS "finalPrice", r.payout_mode AS "payoutMode",
  r.upi_id AS "upiId", r.verified_purchase AS "verifiedPurchase", r.status, r.lot_id AS "lotId", r.inspection, r.inspected_at AS "inspectedAt",
  r.handover_due AS "handoverDue", r.reject_reason AS "rejectReason", r.season, r.created_at AS "createdAt",
  c.name AS "centerName", c.village AS "centerVillage",
  (SELECT count(*)::int FROM resale_photo ph WHERE ph.listing_id = r.id) AS "photoCount",
  COALESCE((SELECT l.quantity - l.reserved FROM surplus_lot l WHERE l.id = r.lot_id), 0) AS "unitsAvailable",
  COALESCE((SELECT l.reserved FROM surplus_lot l WHERE l.id = r.lot_id), 0) AS "unitsReserved",
  COALESCE((SELECT sum(s.units) FROM resale_sale s WHERE s.listing_id = r.id), 0)::int AS "unitsSold"`;
const LISTING_FROM = 'resale_listing r JOIN products p ON p.id = r.product_id JOIN village_center c ON c.center_id = r.center_id';

const shape = (row) => row && ({
  ...row,
  catalogPrice: Number(row.catalogPrice),
  askingPrice: Number(row.askingPrice),
  suggestedPrice: Number(row.suggestedPrice),
  finalPrice: row.finalPrice == null ? null : Number(row.finalPrice),
  unitsAvailable: Number(row.unitsAvailable),
  unitsReserved: Number(row.unitsReserved),
});

const getListing = async (q, id) => {
  const { rows } = await q.query(`SELECT ${LISTING_COLUMNS} FROM ${LISTING_FROM} WHERE r.id = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'Listing not found');
  return shape(rows[0]);
};

const mineOrThrow = async (q, seller, id) => {
  const l = await getListing(q, id);
  if (l.sellerId !== seller) throw new HttpError(404, 'Listing not found');
  return l;
};

const ofCenterOrThrow = async (q, centerId, id) => {
  const l = await getListing(q, id);
  if (l.centerId !== centerId) throw new HttpError(404, 'Listing not found');
  return l;
};

// What this farmer bought from the platform and collected, and how much of it may still be resold.
const eligibleProducts = async (db, seller, now = new Date()) => {
  const season = seasonOf(now);
  const { rows } = await db.query(
    `SELECT p.id AS "productId", p.name, p.brand, p.unit_label AS "unit", p.price_in_rupees AS "catalogPrice", p.weight_kg AS "weightKg",
            sum(i.quantity)::int AS purchased, max(o.created_at) AS "lastBought",
            (array_agg(o.id ORDER BY o.created_at DESC))[1] AS "lastOrderId"
       FROM orders o JOIN order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id
      WHERE o.owner_id = $1 AND o.status = 'completed' AND i.surplus_lot_id IS NULL AND p.category = 'organic'
      GROUP BY p.id ORDER BY max(o.created_at) DESC`, [seller],
  );
  const used = (await db.query(
    `SELECT product_id AS "productId", sum(units)::int AS units, count(*) FILTER (WHERE season = $2)::int AS "thisSeason"
       FROM resale_listing WHERE seller_id = $1 AND status NOT IN ('rejected','withdrawn') GROUP BY product_id`, [seller, season],
  )).rows;
  const byProduct = new Map(used.map((u) => [u.productId, u]));
  // A listing that was withdrawn or rejected still counts toward the season's three, so it cannot be abused.
  const attempts = (await db.query(
    'SELECT product_id AS "productId", count(*)::int AS n FROM resale_listing WHERE seller_id = $1 AND season = $2 GROUP BY product_id', [seller, season],
  )).rows;
  const tries = new Map(attempts.map((a) => [a.productId, a.n]));
  return rows.map((r) => {
    const u = byProduct.get(r.productId);
    const listed = u ? u.units : 0;
    const listingsThisSeason = tries.get(r.productId) || 0;
    return {
      ...r,
      catalogPrice: Number(r.catalogPrice),
      weightKg: Number(r.weightKg),
      alreadyListed: listed,
      remaining: Math.max(r.purchased - listed, 0),
      listingsThisSeason,
      listingsLeft: Math.max(MAX_LISTINGS_PER_SEASON - listingsThisSeason, 0),
    };
  });
};

const minimumUnits = (product) => {
  // At least 2 kg, or 1 litre for a liquid, in total.
  const litres = /\bl(itre|iter)?s?\b/i.test(product.unit_label) && !/kg/i.test(product.unit_label);
  const each = Number(product.weight_kg) || 1;
  return Math.max(Math.ceil((litres ? 1 : 2) / each), 1);
};

// The price a farmer may choose, and what would be suggested, for the given goods.
const suggest = async (db, { productId, condition, visual, mfgDate }) => {
  const product = (await db.query('SELECT id, price_in_rupees AS price, category FROM products WHERE id = $1', [productId])).rows[0];
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.category !== 'organic') throw new HttpError(409, 'Only organic fertilizers can be resold on the platform');
  return priceGuide({ catalogPrice: product.price, condition, visual, mfgDate });
};

const checkPrice = (price, guide) => {
  if (price < guide.min || price > guide.max) {
    throw new HttpError(400, `The price must be between Rs ${guide.min} and Rs ${guide.max} per unit (40% to 90% of the platform price)`);
  }
};

// ---- the farmer lists --------------------------------------------------------------------------

const createDraft = async (db, { seller, productId, units, condition, mfgDate, expiryDate, batchNumber, askingPrice, centerId, payoutMode, upiId, now = new Date() }) =>
  db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`resale:${seller}`]);
    const product = (await c.query('SELECT id, name, category, price_in_rupees AS price, unit_label, weight_kg FROM products WHERE id = $1', [productId])).rows[0];
    if (!product) throw new HttpError(404, 'Product not found');
    if (product.category !== 'organic') throw new HttpError(409, 'Only organic fertilizers can be resold on the platform');

    const today = todayUtc(now);
    if (expiryDate < today || expiryDate === today) throw new HttpError(409, 'This product has expired or expires today, so it cannot be listed');
    if (mfgDate && mfgDate > today) throw new HttpError(400, 'The manufacturing date cannot be in the future');
    if (mfgDate && mfgDate >= expiryDate) throw new HttpError(400, 'The manufacturing date must be before the expiry date');
    if (payoutMode === 'upi' && !upiId) throw new HttpError(400, 'Give your UPI id to be paid by UPI');

    const minUnits = minimumUnits({ unit_label: product.unit_label, weight_kg: product.weight_kg });
    if (units < minUnits) throw new HttpError(400, `The smallest quantity that can be listed is 2 kg (1 litre for a liquid): at least ${minUnits} of ${product.unit_label}`);

    const center = (await c.query("SELECT center_id FROM village_center WHERE center_id = $1 AND status = 'active'", [centerId])).rows[0];
    if (!center) throw new HttpError(404, 'Village center not found');

    const eligible = (await eligibleProducts(c, seller, now)).find((e) => e.productId === productId);
    if (!eligible) throw new HttpError(409, 'You can only resell products you bought on the platform and collected');
    if (eligible.listingsLeft <= 0) throw new HttpError(409, `You have listed this product ${MAX_LISTINGS_PER_SEASON} times this season, which is the most allowed`);
    if (units > eligible.remaining) throw new HttpError(409, `You bought ${eligible.purchased} of this product and already listed ${eligible.alreadyListed}, so you can list at most ${eligible.remaining} more`);

    const guide = priceGuide({ catalogPrice: product.price, condition, mfgDate, today: now });
    checkPrice(askingPrice, guide);

    const id = `resale-${crypto.randomUUID()}`;
    await c.query(
      `INSERT INTO resale_listing (id, seller_id, center_id, product_id, channel, units, condition, mfg_date, expiry_date, batch_number, asking_price,
                                   suggested_price, payout_mode, upi_id, purchase_order_id, verified_purchase, status, season)
       VALUES ($1,$2,$3,$4,'digital',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,'draft',$15)`,
      [id, seller, centerId, productId, units, condition, mfgDate || null, expiryDate, batchNumber || '', askingPrice, guide.suggested, payoutMode, upiId || '', eligible.lastOrderId, seasonOf(now)],
    );
    return getListing(c, id);
  });

const detectPhoto = async (buffer) => {
  if (!buffer || !buffer.length) throw new HttpError(400, 'Missing photo');
  if (buffer.length > 5 * 1024 * 1024) throw new HttpError(413, 'That photo is too large (max 5 MB)');
  try {
    const { format } = await sharp(buffer).metadata();
    const type = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[format];
    if (type) return type;
  } catch {
    // falls through
  }
  throw new HttpError(422, 'Upload a photo (JPEG, PNG or WebP)');
};

const savePhoto = async (db, seller, id, kind, buffer) => {
  if (!['front', 'back'].includes(kind)) throw new HttpError(404, 'Photo kind must be front or back');
  const listing = await mineOrThrow(db, seller, id);
  if (!['draft', 'pending_verification', 'inspection_required'].includes(listing.status)) throw new HttpError(409, 'This listing can no longer be changed');
  const contentType = await detectPhoto(buffer);
  await db.query(
    `INSERT INTO resale_photo (listing_id, kind, content_type, data) VALUES ($1,$2,$3,$4)
     ON CONFLICT (listing_id, kind) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, uploaded_at = now()`,
    [id, kind, contentType, buffer],
  );
  return getListing(db, id);
};

const readPhoto = async (q, id, kind) => {
  const { rows } = await q.query('SELECT content_type AS "contentType", data FROM resale_photo WHERE listing_id = $1 AND kind = $2', [id, kind]);
  if (!rows.length) throw new HttpError(404, 'That photo was not uploaded');
  return rows[0];
};

// Sends a draft to the village center for checking. It needs both photos of the bag.
const submit = async (db, seller, id) =>
  db.tx(async (c) => {
    const listing = await mineOrThrow(c, seller, id);
    if (listing.status !== 'draft') throw new HttpError(409, 'This listing was already sent');
    if (listing.photoCount < 2) throw new HttpError(409, 'Add a photo of the front and of the back of the bag first');
    await c.query("UPDATE resale_listing SET status = 'pending_verification', updated_at = now() WHERE id = $1", [id]);
    const operator = (await c.query('SELECT operator_id FROM village_center WHERE center_id = $1', [listing.centerId])).rows[0];
    if (operator) {
      await notify(c, operator.operator_id, {
        type: 'order', title: 'A farmer wants to sell surplus',
        body: `${listing.units} x ${listing.productName} at Rs ${listing.askingPrice} each. Check the photos and approve it, or ask them to bring it in first.`, refId: id,
      });
    }
    return getListing(c, id);
  });

const listMine = async (db, seller) =>
  (await db.query(`SELECT ${LISTING_COLUMNS} FROM ${LISTING_FROM} WHERE r.seller_id = $1 ORDER BY r.created_at DESC, r.id`, [seller])).rows.map(shape);

// Everything about one of my listings: the listing, what sold, and how I am being paid.
const detailMine = async (db, seller, id) => {
  const listing = await mineOrThrow(db, seller, id);
  const sales = (await db.query(
    `SELECT sale_id AS "saleId", order_id AS "orderId", units, unit_price::float8 AS "unitPrice", gross::float8 AS gross, platform_fee::float8 AS "platformFee",
            operator_cut::float8 AS "operatorCut", seller_net::float8 AS "sellerNet", verified, payout_mode AS "payoutMode", payout_status AS "payoutStatus", created_at AS "createdAt"
       FROM resale_sale WHERE listing_id = $1 ORDER BY created_at DESC`, [id],
  )).rows;
  return { ...listing, sales, youReceive: youReceive(listing) };
};

// What the seller would get for one unit, before it sells.
const youReceive = (l) => {
  const price = l.finalPrice ?? l.askingPrice;
  const c = commission({ gross: price, verified: l.verifiedPurchase, payoutMode: l.payoutMode });
  return { perUnit: c.sellerNet, platformPct: c.platformPct, operatorPct: c.operatorPct, cashKeepPercent: l.payoutMode === 'cash' ? CASH_KEEP * 100 : 100 };
};

// Takes the lot off sale. Units a buyer still holds stay until that order ends.
const withdrawLotOf = async (c, listing) => {
  if (!listing.lotId) return;
  await c.query("UPDATE surplus_lot SET status = 'withdrawn', quantity = reserved WHERE id = $1", [listing.lotId]);
};

const openOrdersOnLot = async (q, lotId) =>
  (await q.query(
    `SELECT DISTINCT o.id, o.owner_id AS "ownerId" FROM orders o JOIN order_items i ON i.order_id = o.id
      WHERE i.surplus_lot_id = $1 AND o.status IN ('pending','readyForPickup')`, [lotId],
  )).rows;

// Cancels every open buyer order holding units of a lot, telling each buyer why. Each cancellation is its own
// transaction (it releases stock and queues refunds), so this runs outside the caller's.
const cancelBuyerOrders = async (db, lotId, why) => {
  if (!lotId) return 0;
  const { cancelOrder } = require('./orders');
  const orders = await openOrdersOnLot(db, lotId);
  for (const o of orders) {
    await cancelOrder(db, o.id, (c, current) =>
      notify(c, current.ownerId, { type: 'order', title: 'Your order was cancelled', body: why, refId: current.id }));
  }
  return orders.length;
};

const withdrawMine = async (db, seller, id) => {
  const listing = await mineOrThrow(db, seller, id);
  if (!['draft', 'pending_verification', 'inspection_required', 'live', 'awaiting_handover', 'listed'].includes(listing.status)) throw new HttpError(409, `A ${listing.status.replace('_', ' ')} listing cannot be withdrawn`);
  if (listing.unitsReserved > 0) throw new HttpError(409, 'A buyer has already reserved some of this, so it cannot be withdrawn. Ask the center if there is a problem.');
  await db.tx(async (c) => {
    await withdrawLotOf(c, listing);
    await c.query("UPDATE resale_listing SET status = 'withdrawn', updated_at = now() WHERE id = $1", [id]);
    if (listing.status === 'listed') {
      const operator = (await c.query('SELECT operator_id FROM village_center WHERE center_id = $1', [listing.centerId])).rows[0];
      if (operator) await notify(c, operator.operator_id, { type: 'order', title: 'A seller took their goods back', body: `Hand back ${listing.units} x ${listing.productName} to the farmer.`, refId: id });
    }
  });
  return getListing(db, id);
};

// ---- the center ---------------------------------------------------------------------------------

const queue = async (db, centerId, statuses) => {
  const wanted = statuses && statuses.length ? statuses : ['pending_verification', 'inspection_required', 'live', 'awaiting_handover'];
  return (await db.query(
    `SELECT ${LISTING_COLUMNS} FROM ${LISTING_FROM} WHERE r.center_id = $1 AND r.status = ANY($2) AND r.status <> 'draft'
      ORDER BY r.created_at DESC, r.id`, [centerId, wanted],
  )).rows.map(shape);
};

// Puts the units on the center's surplus list. Until the goods are physically received the lot is
// live for buyers but cannot be collected.
const openLot = async (c, listing, { units, price, expiryDate, condition, received }) => {
  const id = `lot-${crypto.randomUUID()}`;
  await c.query(
    `INSERT INTO surplus_lot (id, center_id, product_id, quantity, unit_price, condition, best_before, note, from_shelf, resale_id, physical_received)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9,$10)`,
    [id, listing.centerId, listing.productId, units, price, condition, expiryDate, 'Farmer resale', listing.id, received],
  );
  return id;
};

// Remote pre-approval: the photos look fine, so the listing goes live now. The goods are inspected
// when the seller brings them, which starts when a buyer is found.
const preapprove = async (db, { centerId, actor, id }) => {
  const listing = await ofCenterOrThrow(db, centerId, id);
  if (listing.status !== 'pending_verification') throw new HttpError(409, `A ${listing.status.replace('_', ' ')} listing cannot be pre-approved`);
  await db.tx(async (c) => {
    const lotId = await openLot(c, listing, { units: listing.units, price: listing.askingPrice, expiryDate: listing.expiryDate, condition: listing.condition, received: false });
    await c.query("UPDATE resale_listing SET status = 'live', lot_id = $2, final_price = asking_price, updated_at = now() WHERE id = $1", [id, lotId]);
    await notify(c, listing.sellerId, {
      type: 'order', title: 'Your listing is live',
      body: `${listing.productName} is on the marketplace at Rs ${listing.askingPrice}. When a buyer orders it you will have ${HANDOVER_HOURS} hours to bring it to ${listing.centerName}.`, refId: id,
    });
  });
  try {
    await require('./backInStock').notifyNewSurplus(db, { lotId: (await getListing(db, id)).lotId });
  } catch (err) {
    console.error('Surplus alerts failed:', err.message);
  }
  return getListing(db, id);
};

const requestInspection = async (db, { centerId, id, note }) => {
  const listing = await ofCenterOrThrow(db, centerId, id);
  if (listing.status !== 'pending_verification') throw new HttpError(409, `A ${listing.status.replace('_', ' ')} listing cannot be sent for inspection`);
  await db.tx(async (c) => {
    await c.query("UPDATE resale_listing SET status = 'inspection_required', updated_at = now() WHERE id = $1", [id]);
    await notify(c, listing.sellerId, {
      type: 'order', title: 'Please bring it to the center',
      body: `${listing.centerName} needs to see your ${listing.productName} before it goes on sale.${note ? ` ${note}` : ''}`, refId: id,
    });
  });
  return getListing(db, id);
};

const rejectListing = async (db, { centerId, id, reason }) => {
  const listing = await ofCenterOrThrow(db, centerId, id);
  if (!LIVE_STATES.includes(listing.status)) throw new HttpError(409, `A ${listing.status.replace('_', ' ')} listing cannot be rejected`);
  if (listing.unitsSold > 0) throw new HttpError(409, 'Part of this listing was already sold');
  const cancelled = await cancelBuyerOrders(db, listing.lotId, `The seller's goods did not pass the center's check: ${reason}. Your order was cancelled and any payment is being refunded.`);
  await db.tx(async (c) => {
    await withdrawLotOf(c, listing);
    await c.query("UPDATE resale_listing SET status = 'rejected', reject_reason = $2, handover_due = NULL, updated_at = now() WHERE id = $1", [id, reason]);
    await notify(c, listing.sellerId, { type: 'order', title: 'Your listing was not accepted', body: `${listing.productName}: ${reason}`, refId: id });
  });
  return { ...(await getListing(db, id)), buyerOrdersCancelled: cancelled };
};

// What the operator checks with the goods in front of them. Anything that makes the product unfit to
// sell is a hard stop, not a warning.
const validateChecklist = (listing, cl, now = new Date()) => {
  const blocks = [];
  if (cl.productMatches !== true) blocks.push('The bag cannot be matched to a product sold on the platform');
  if (cl.expiryDate <= todayUtc(now)) blocks.push('The product has expired');
  if (cl.seal === 'damaged_packaging') blocks.push('The packaging is severely damaged');
  if (cl.visual === 'wet') blocks.push('The product is wet or spoiled');
  if (!cl.batchNumber || cl.batchNumber.trim().length < 2) blocks.push('The batch number is missing or unreadable');
  return blocks;
};

const conditionFromSeal = (seal) => (seal === 'sealed' ? 'sealed' : seal === 'opened_resealed' ? 'opened' : 'partially_used');

// The physical check at the center. It approves (creating or updating the surplus lot, now received),
// or stops for one of the hard reasons. A worse condition than listed can only lower the price.
const inspect = async (db, { centerId, actor, id, checklist, now = new Date() }) => {
  const listing = await ofCenterOrThrow(db, centerId, id);
  if (!['pending_verification', 'inspection_required', 'live', 'awaiting_handover'].includes(listing.status)) {
    throw new HttpError(409, `A ${listing.status.replace('_', ' ')} listing cannot be inspected`);
  }
  const cl = checklist;
  const blocks = validateChecklist(listing, cl, now);
  if (blocks.length) throw new HttpError(409, `This cannot be accepted: ${blocks.join('; ')}.`, { blocks });
  if (cl.units > listing.units) throw new HttpError(409, `The seller listed ${listing.units}, you counted ${cl.units}. A listing cannot grow: reject it and create a new one.`);
  if (cl.units < listing.unitsReserved) throw new HttpError(409, `${listing.unitsReserved} units are already reserved by buyers. You cannot accept fewer: reject the listing, or ask the seller for more.`);

  const product = (await db.query('SELECT price_in_rupees AS price FROM products WHERE id = $1', [listing.productId])).rows[0];
  const condition = conditionFromSeal(cl.seal);
  const guide = priceGuide({ catalogPrice: product.price, condition, visual: cl.visual, mfgDate: cl.mfgDate || listing.mfgDate, today: now });
  // The price never goes up at the counter; it can be lowered, and it must stay within the allowed range.
  const current = listing.finalPrice ?? listing.askingPrice;
  const chosen = cl.unitPrice ?? Math.min(current, guide.suggested);
  if (chosen > current) throw new HttpError(400, 'At the counter the price can only be lowered, not raised');
  checkPrice(chosen, guide);

  const verifiedPurchase = listing.verifiedPurchase || cl.purchaseProofSeen === true;
  await db.tx(async (c) => {
    if (listing.lotId) {
      await c.query(
        `UPDATE surplus_lot SET physical_received = true, quantity = $2, unit_price = $3, best_before = $4, condition = $5 WHERE id = $1`,
        [listing.lotId, cl.units, chosen, cl.expiryDate, condition],
      );
    }
    let lotId = listing.lotId;
    if (!lotId) lotId = await openLot(c, listing, { units: cl.units, price: chosen, expiryDate: cl.expiryDate, condition, received: true });
    await c.query(
      `UPDATE resale_listing SET status = 'listed', lot_id = $2, units = $3, condition = $4, mfg_date = $5, expiry_date = $6, batch_number = $7, final_price = $8,
              verified_purchase = $9, inspection = $10::jsonb, inspected_by = $11, inspected_at = now(), handover_due = NULL, updated_at = now() WHERE id = $1`,
      [id, lotId, cl.units, condition, cl.mfgDate || listing.mfgDate, cl.expiryDate, cl.batchNumber.trim(), chosen, verifiedPurchase, JSON.stringify({ ...cl, condition, price: chosen, suggestedAtCounter: guide.suggested }), actor],
    );
    if (listing.sellerId) {
      await notify(c, listing.sellerId, {
        type: 'order', title: 'Your goods were accepted',
        body: `${listing.centerName} checked your ${listing.productName}. It is listed at Rs ${chosen} per unit${chosen < listing.askingPrice ? ` (lowered from Rs ${listing.askingPrice})` : ''}.`, refId: id,
      });
    }
  });
  const updated = await getListing(db, id);
  if (!listing.lotId) {
    try { await require('./backInStock').notifyNewSurplus(db, { lotId: updated.lotId }); } catch (err) { console.error('Surplus alerts failed:', err.message); }
  }
  return updated;
};

// A farmer standing at the counter with goods to sell. A registered farmer is found by their id; anyone else can
// sell too, but is paid in cash and never counts as a verified purchase.
const walkIn = async (db, { centerId, actor, sellerId, sellerName, sellerPhone, productId, checklist, payoutMode, now = new Date() }) => {
  const cl = checklist;
  const product = (await db.query('SELECT id, name, category, price_in_rupees AS price, unit_label, weight_kg FROM products WHERE id = $1', [productId])).rows[0];
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.category !== 'organic') throw new HttpError(409, 'Only organic fertilizers can be resold on the platform');
  const blocks = validateChecklist({}, cl, now);
  if (blocks.length) throw new HttpError(409, `This cannot be accepted: ${blocks.join('; ')}.`, { blocks });
  const minUnits = minimumUnits(product);
  if (cl.units < minUnits) throw new HttpError(400, `The smallest quantity is 2 kg (1 litre for a liquid): at least ${minUnits} of ${product.unit_label}`);

  const registered = Boolean(sellerId);
  if (!registered && (!sellerName || !sellerPhone)) throw new HttpError(400, 'Give the seller\'s name and phone number');
  const mode = registered ? payoutMode : 'cash';
  if (!registered && payoutMode && payoutMode !== 'cash') throw new HttpError(400, 'A seller with no account can only be paid in cash');

  let verified = false;
  let orderId = null;
  let name = sellerName || '';
  if (registered) {
    const profile = (await db.query('SELECT name FROM profiles WHERE owner_id = $1', [sellerId])).rows[0];
    name = profile ? profile.name : name;
    const eligible = (await eligibleProducts(db, sellerId, now)).find((e) => e.productId === productId);
    if (eligible) {
      if (eligible.listingsLeft <= 0) throw new HttpError(409, `This farmer has listed this product ${MAX_LISTINGS_PER_SEASON} times this season, which is the most allowed`);
      verified = cl.purchaseProofSeen === true || eligible.remaining >= cl.units;
      orderId = eligible.lastOrderId;
    } else {
      verified = cl.purchaseProofSeen === true;
    }
  } else {
    verified = false; // no account, so no platform order to check
  }
  if (mode === 'upi' && !cl.upiId) throw new HttpError(400, 'Give the UPI id to pay by UPI');

  const condition = conditionFromSeal(cl.seal);
  const guide = priceGuide({ catalogPrice: product.price, condition, visual: cl.visual, mfgDate: cl.mfgDate, today: now });
  const price = cl.unitPrice ?? guide.suggested;
  checkPrice(price, guide);

  const id = `resale-${crypto.randomUUID()}`;
  await db.tx(async (c) => {
    await c.query(
      `INSERT INTO resale_listing (id, seller_id, seller_name, seller_phone, center_id, product_id, channel, units, condition, mfg_date, expiry_date, batch_number,
                                   asking_price, suggested_price, final_price, payout_mode, upi_id, purchase_order_id, verified_purchase, status, season, inspection, inspected_by, inspected_at)
       VALUES ($1,$2,$3,$4,$5,$6,'walk_in',$7,$8,$9,$10,$11,$12,$13,$12,$14,$15,$16,$17,'draft',$18,$19::jsonb,$20, now())`,
      [id, sellerId || null, name, sellerPhone || '', centerId, productId, cl.units, condition, cl.mfgDate || null, cl.expiryDate, cl.batchNumber.trim(), price, guide.suggested, mode,
        cl.upiId || '', orderId, verified, seasonOf(now), JSON.stringify({ ...cl, condition, price }), actor],
    );
    const lotId = await openLot(c, { id, centerId, productId }, { units: cl.units, price, expiryDate: cl.expiryDate, condition, received: true });
    await c.query("UPDATE resale_listing SET status = 'listed', lot_id = $2 WHERE id = $1", [id, lotId]);
    if (sellerId) {
      await notify(c, sellerId, { type: 'order', title: 'Your goods are on sale', body: `${cl.units} x ${product.name} listed at Rs ${price} each at your village center.`, refId: id });
    }
  });
  const created = await getListing(db, id);
  try { await require('./backInStock').notifyNewSurplus(db, { lotId: created.lotId }); } catch (err) { console.error('Surplus alerts failed:', err.message); }
  return created;
};

// Registered farmers the operator can pick from at the counter.
const findSellers = async (db, q) => {
  const like = `%${String(q || '').replace(/[\\%_]/g, '\\$&')}%`;
  return (await db.query(
    `SELECT owner_id AS "sellerId", name, village, contact_phone AS phone FROM profiles
      WHERE owner_id NOT LIKE 'op-%' AND (name ILIKE $1 OR contact_phone ILIKE $1 OR village ILIKE $1) AND name <> 'Farmer' ORDER BY name LIMIT 20`, [like],
  )).rows;
};

// ---- buyers and the order flow -----------------------------------------------------------------

// A buyer ordered units of a live listing that is not yet at the center: the seller has 48 hours.
const onLotsReserved = async (c, lotIds, now = new Date()) => {
  for (const lotId of lotIds) {
    const l = (await c.query(
      `SELECT r.id, r.seller_id, r.status, p.name AS product, cn.name AS center FROM resale_listing r JOIN surplus_lot s ON s.resale_id = r.id
         JOIN products p ON p.id = r.product_id JOIN village_center cn ON cn.center_id = r.center_id WHERE s.id = $1 AND s.physical_received = false FOR UPDATE OF r`, [lotId],
    )).rows[0];
    if (!l || l.status === 'awaiting_handover') continue;
    const due = new Date(now.getTime() + HANDOVER_HOURS * 3600 * 1000);
    await c.query("UPDATE resale_listing SET status = 'awaiting_handover', handover_due = $2, updated_at = now() WHERE id = $1", [l.id, due]);
    await notify(c, l.seller_id, {
      type: 'order', title: 'Your fertilizer has a buyer',
      body: `Please bring your ${l.product} to ${l.center} within ${HANDOVER_HOURS} hours. The center will check it and hand it to the buyer.`, refId: l.id,
    });
  }
};

// The operator may not hand over goods the seller has not yet brought in.
const assertHandable = async (c, order) => {
  const lotIds = order.items.filter((i) => i.surplusLotId).map((i) => i.surplusLotId);
  if (!lotIds.length) return;
  const waiting = (await c.query('SELECT 1 FROM surplus_lot WHERE id = ANY($1) AND physical_received = false LIMIT 1', [lotIds])).rows.length > 0;
  if (waiting) throw new HttpError(409, "The seller has not brought this in yet. Inspect the goods first (Inventory > Farmer resale), then hand them over.");
};

// The order was collected: the sale is recorded, the seller's share worked out and paid or queued.
const recordSales = async (c, order, now = new Date()) => {
  for (const item of order.items.filter((i) => i.surplusLotId)) {
    const l = (await c.query(
      `SELECT r.id, r.seller_id, r.seller_name, r.center_id, r.verified_purchase, r.payout_mode, r.units, p.name AS product
         FROM resale_listing r JOIN surplus_lot s ON s.resale_id = r.id JOIN products p ON p.id = r.product_id WHERE s.id = $1 FOR UPDATE OF r`, [item.surplusLotId],
    )).rows[0];
    if (!l) continue;
    const gross = money(item.quantity * Number(item.unitPrice));
    const split = commission({ gross, verified: l.verified_purchase, payoutMode: l.payout_mode });
    // A wallet payout is instant. UPI goes out within a day or two; cash is collected at the center.
    const payoutStatus = l.payout_mode === 'wallet' ? 'paid' : l.payout_mode === 'upi' ? 'pending' : 'cash_due';
    const saleId = `sale-${crypto.randomUUID()}`;
    await c.query(
      `INSERT INTO resale_sale (sale_id, listing_id, order_id, center_id, seller_id, buyer_id, units, unit_price, gross, platform_fee, operator_cut, seller_net, verified, payout_mode, payout_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (listing_id, order_id) DO NOTHING`,
      [saleId, l.id, order.id, l.center_id, l.seller_id, order.ownerId, item.quantity, item.unitPrice, gross, split.platformFee, split.operatorCut, split.sellerNet, l.verified_purchase, l.payout_mode, payoutStatus],
    );
    if (l.seller_id) {
      if (l.payout_mode === 'wallet') await wallet.addEntry(c, l.seller_id, split.sellerNet, 'resale_earning', saleId, `Sold ${item.quantity} x ${l.product}`);
      const when = l.payout_mode === 'wallet' ? 'It is in your wallet now.' : l.payout_mode === 'upi' ? 'It will reach your UPI in 24 to 48 hours.' : 'Collect the cash at the village center.';
      await notify(c, l.seller_id, { type: 'order', title: 'Your fertilizer sold', body: `You earned Rs ${split.sellerNet}. ${when}`, refId: l.id });
    }
    const sold = (await c.query('SELECT COALESCE(SUM(units), 0)::int AS n FROM resale_sale WHERE listing_id = $1', [l.id])).rows[0].n;
    if (sold >= l.units) await c.query("UPDATE resale_listing SET status = 'sold_out', updated_at = now() WHERE id = $1", [l.id]);
  }
};

// ---- payouts -----------------------------------------------------------------------------------

const cashDue = async (db, centerId) =>
  (await db.query(
    `SELECT s.sale_id AS "saleId", s.listing_id AS "listingId", s.seller_net::float8 AS amount, s.created_at AS "createdAt", p.name AS "productName", s.units,
            COALESCE(NULLIF(r.seller_name, ''), pr.name, 'Farmer') AS "sellerName", r.seller_phone AS "sellerPhone"
       FROM resale_sale s JOIN resale_listing r ON r.id = s.listing_id JOIN products p ON p.id = r.product_id LEFT JOIN profiles pr ON pr.owner_id = s.seller_id
      WHERE s.center_id = $1 AND s.payout_status = 'cash_due' ORDER BY s.created_at`, [centerId],
  )).rows;

const markCashPaid = async (db, { centerId, saleId }) =>
  db.tx(async (c) => {
    const s = (await c.query('SELECT sale_id, seller_id, seller_net, payout_status, center_id FROM resale_sale WHERE sale_id = $1 FOR UPDATE', [saleId])).rows[0];
    if (!s || s.center_id !== centerId) throw new HttpError(404, 'Sale not found');
    if (s.payout_status !== 'cash_due') throw new HttpError(409, 'That cash was already handed over');
    await c.query("UPDATE resale_sale SET payout_status = 'cash_paid', payout_ref = 'cash at center' WHERE sale_id = $1", [saleId]);
    await notify(c, s.seller_id, { type: 'order', title: 'Cash handed over', body: `The center recorded Rs ${money(s.seller_net)} paid to you in cash.`, refId: saleId });
    return { saleId, status: 'cash_paid' };
  });

const upiPending = async (db) =>
  (await db.query(
    `SELECT s.sale_id AS "saleId", s.seller_net::float8 AS amount, s.created_at AS "createdAt", r.upi_id AS "upiId", COALESCE(pr.name, 'Farmer') AS "sellerName", c.name AS "centerName"
       FROM resale_sale s JOIN resale_listing r ON r.id = s.listing_id LEFT JOIN profiles pr ON pr.owner_id = s.seller_id JOIN village_center c ON c.center_id = s.center_id
      WHERE s.payout_status = 'pending' ORDER BY s.created_at`,
  )).rows;

const markUpiPaid = async (db, { saleId, reference }) =>
  db.tx(async (c) => {
    const s = (await c.query('SELECT sale_id, seller_id, seller_net, payout_status FROM resale_sale WHERE sale_id = $1 FOR UPDATE', [saleId])).rows[0];
    if (!s) throw new HttpError(404, 'Sale not found');
    if (s.payout_status !== 'pending') throw new HttpError(409, 'That payout was already sent');
    await c.query("UPDATE resale_sale SET payout_status = 'paid', payout_ref = $2 WHERE sale_id = $1", [saleId, reference || '']);
    await notify(c, s.seller_id, { type: 'order', title: 'UPI payout sent', body: `Rs ${money(s.seller_net)} was sent to your UPI.${reference ? ` Reference: ${reference}` : ''}`, refId: saleId });
    return { saleId, status: 'paid' };
  });

// ---- disputes -----------------------------------------------------------------------------------

const raiseDispute = async (db, { buyer, orderId, reason, now = new Date() }) =>
  db.tx(async (c) => {
    const s = (await c.query(
      'SELECT sale_id, buyer_id, created_at, center_id, listing_id FROM resale_sale WHERE order_id = $1 ORDER BY created_at LIMIT 1 FOR UPDATE', [orderId],
    )).rows[0];
    if (!s || s.buyer_id !== buyer) throw new HttpError(404, 'No surplus purchase found for that order');
    if (now.getTime() - new Date(s.created_at).getTime() > DISPUTE_HOURS * 3600 * 1000) throw new HttpError(409, `A complaint must be made within ${DISPUTE_HOURS} hours of collecting the goods`);
    const existing = (await c.query('SELECT 1 FROM resale_dispute WHERE sale_id = $1', [s.sale_id])).rows.length > 0;
    if (existing) throw new HttpError(409, 'You already raised a complaint about this purchase');
    const id = `disp-${crypto.randomUUID()}`;
    await c.query('INSERT INTO resale_dispute (dispute_id, sale_id, order_id, buyer_id, reason) VALUES ($1,$2,$3,$4,$5)', [id, s.sale_id, orderId, buyer, reason]);
    const operator = (await c.query('SELECT operator_id FROM village_center WHERE center_id = $1', [s.center_id])).rows[0];
    if (operator) await notify(c, operator.operator_id, { type: 'order', title: 'A buyer complained about surplus goods', body: 'The platform will review your inspection record.', refId: id });
    return { disputeId: id, status: 'open' };
  });

const disputes = async (db, status) =>
  (await db.query(
    `SELECT d.dispute_id AS "disputeId", d.order_id AS "orderId", d.reason, d.status, d.refund_percent AS "refundPercent", d.refund_amount::float8 AS "refundAmount",
            d.resolution_note AS "resolutionNote", d.created_at AS "createdAt", s.gross::float8 AS gross, s.seller_net::float8 AS "sellerNet", s.listing_id AS "listingId",
            p.name AS "productName", c.name AS "centerName", c.resale_quality AS "centerQuality", r.inspection
       FROM resale_dispute d JOIN resale_sale s ON s.sale_id = d.sale_id JOIN resale_listing r ON r.id = s.listing_id JOIN products p ON p.id = r.product_id
       JOIN village_center c ON c.center_id = s.center_id WHERE ($1::text IS NULL OR d.status = $1) ORDER BY d.created_at DESC`, [status || null],
  )).rows;

// The admin's decision. Upheld: the buyer is refunded to their wallet, the seller's share of that refund comes out of
// their earnings, and the center that approved the listing loses quality points.
const resolveDispute = async (db, { disputeId, decision, refundPercent, note, after }) =>
  db.tx(async (c) => {
    const done = async (result) => {
      if (after) await after(c, result); // e.g. an audit entry, committed with the decision
      return result;
    };
    const d = (await c.query(
      `SELECT d.dispute_id, d.status, d.buyer_id, d.order_id, s.sale_id, s.gross, s.seller_net, s.seller_id, s.center_id, s.payout_mode
         FROM resale_dispute d JOIN resale_sale s ON s.sale_id = d.sale_id WHERE d.dispute_id = $1 FOR UPDATE OF d`, [disputeId],
    )).rows[0];
    if (!d) throw new HttpError(404, 'Complaint not found');
    if (d.status !== 'open') throw new HttpError(409, 'This complaint was already decided');
    if (decision === 'reject') {
      await c.query("UPDATE resale_dispute SET status = 'rejected', resolution_note = $2, resolved_at = now() WHERE dispute_id = $1", [disputeId, note || '']);
      await notify(c, d.buyer_id, { type: 'order', title: 'Your complaint was reviewed', body: note || 'The platform found the goods matched the listing.', refId: disputeId });
      return done({ disputeId, status: 'rejected' });
    }
    const percent = refundPercent;
    const refund = money(Number(d.gross) * percent / 100);
    await wallet.addEntry(c, d.buyer_id, refund, 'dispute_refund', disputeId, 'Refund for a surplus purchase that did not match its listing');
    // The seller bears their own share of the refund, taken from what they earned.
    const sellerShare = money(Number(d.seller_net) * percent / 100);
    if (d.seller_id && sellerShare > 0) {
      await wallet.addEntry(c, d.seller_id, -sellerShare, 'dispute_debit', disputeId, 'Part of a sale refunded to the buyer');
      await notify(c, d.seller_id, { type: 'order', title: 'A buyer was refunded', body: `Rs ${sellerShare} was taken from your wallet because the goods did not match your listing.`, refId: disputeId });
    }
    await c.query('UPDATE village_center SET resale_quality = GREATEST(resale_quality - $2, 0) WHERE center_id = $1', [d.center_id, QUALITY_PENALTY]);
    await c.query("UPDATE resale_dispute SET status = 'upheld', refund_percent = $2, refund_amount = $3, resolution_note = $4, resolved_at = now() WHERE dispute_id = $1", [disputeId, percent, refund, note || '']);
    await notify(c, d.buyer_id, { type: 'order', title: 'You were refunded', body: `Rs ${refund} is in your wallet.`, refId: disputeId });
    return done({ disputeId, status: 'upheld', refundAmount: refund });
  });

// ---- time --------------------------------------------------------------------------------------

// A seller who does not bring the goods within 48 hours of a buyer being found loses the listing, and
// the buyer's order is cancelled.
const runMaintenance = async (db, now = new Date()) => {
  const late = (await db.query(
    "SELECT id FROM resale_listing WHERE status = 'awaiting_handover' AND handover_due < $1 ORDER BY handover_due", [now],
  )).rows;
  let expired = 0;
  for (const { id } of late) {
    const listing = await getListing(db, id);
    await cancelBuyerOrders(db, listing.lotId, 'The seller did not bring the goods to the center in time, so your order was cancelled. Any payment is being refunded.');
    await db.tx(async (c) => {
      await withdrawLotOf(c, listing);
      await c.query("UPDATE resale_listing SET status = 'rejected', reject_reason = 'The goods were not brought to the center within 48 hours of a buyer being found', handover_due = NULL, updated_at = now() WHERE id = $1", [id]);
      await notify(c, listing.sellerId, { type: 'order', title: 'Your listing ended', body: `You did not bring your ${listing.productName} to the center in time, so the buyer's order was cancelled.`, refId: id });
    });
    expired += 1;
  }
  return { expired };
};

// How far away a listing may be seen from. A farmer's resale first shows to its own center's area; after a week the
// neighbouring centers see it too.
const visibleFrom = (lot, distanceKm, now = new Date()) => {
  if (!lot.isFarmerResale) return true;
  const age = (now.getTime() - new Date(lot.createdAt).getTime()) / DAY;
  return age >= NEIGHBOUR_AFTER_DAYS || distanceKm <= OWN_AREA_KM;
};

module.exports = {
  PRICE_MIN, PRICE_MAX, MAX_LISTINGS_PER_SEASON, HANDOVER_HOURS, DISPUTE_HOURS, NEIGHBOUR_AFTER_DAYS, OWN_AREA_KM, CASH_KEEP,
  CONDITIONS, PAYOUT_MODES, SEALS, VISUALS,
  seasonOf, ageFactor, conditionBand, priceGuide, commission, minimumUnits, visibleFrom, round1,
  getListing, eligibleProducts, suggest, createDraft, savePhoto, readPhoto, submit, listMine, detailMine, withdrawMine,
  queue, preapprove, requestInspection, rejectListing, inspect, walkIn, findSellers,
  onLotsReserved, assertHandable, recordSales, cashDue, markCashPaid, upiPending, markUpiPaid, raiseDispute, disputes, resolveDispute, runMaintenance,
};
