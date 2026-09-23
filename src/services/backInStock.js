const { haversineKm, boundingBox } = require('./geo');
const { LOT_LIVE } = require('./surplus');
const { notify } = require('./notifications');

// How far from a subscriber a center can be and still count as "near them".
// Matches the widest search radius farmers are shown.
const NOTIFY_RADIUS_KM = 35;

// A farmer asks to be told when a product they could not get is available near
// them again. The place they asked from is what "near" means later.
const subscribe = (q, { ownerId, productId, latitude, longitude }) =>
  q.query(
    `INSERT INTO stock_subscription (owner_id, product_id, latitude, longitude) VALUES ($1,$2,$3,$4)
     ON CONFLICT (owner_id, product_id) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude`,
    [ownerId, productId, latitude, longitude],
  );

const unsubscribe = (q, ownerId, productId) =>
  q.query('DELETE FROM stock_subscription WHERE owner_id = $1 AND product_id = $2', [ownerId, productId]);

const isSubscribed = async (q, ownerId, productId) =>
  (await q.query('SELECT 1 FROM stock_subscription WHERE owner_id = $1 AND product_id = $2', [ownerId, productId])).rows.length > 0;

// Called after a center receives stock: tells every subscriber within range of
// that center, once, and ends their subscription. Does nothing if the product
// is not actually available to sell there (everything is already reserved).
// Returns how many farmers were told.
const notifyBackInStock = async (db, { centerId, productId }) => {
  return db.tx(async (c) => {
    const { rows: [shelf] } = await c.query(
      `SELECT ci.on_hand - ci.reserved AS available, ce.name, ce.village, ce.latitude, ce.longitude, p.name AS "productName"
         FROM center_inventory ci JOIN village_center ce ON ce.center_id = ci.center_id JOIN products p ON p.id = ci.product_id
        WHERE ci.center_id = $1 AND ci.product_id = $2 AND ce.status = 'active' AND ce.operator_id IS NOT NULL`,
      [centerId, productId],
    );
    if (!shelf || shelf.available <= 0) return 0;

    const box = boundingBox(shelf, NOTIFY_RADIUS_KM);
    // Locking the rows means two receipts at the same moment cannot both tell the same farmer.
    const { rows: subs } = await c.query(
      `SELECT owner_id AS "ownerId", latitude, longitude FROM stock_subscription
        WHERE product_id = $1 AND latitude BETWEEN $2 AND $3 AND longitude BETWEEN $4 AND $5 FOR UPDATE`,
      [productId, box.minLat, box.maxLat, box.minLng, box.maxLng],
    );
    let told = 0;
    for (const s of subs) {
      const km = haversineKm(shelf, s);
      if (km > NOTIFY_RADIUS_KM) continue;
      await notify(c, s.ownerId, {
        type: 'stock',
        title: `${shelf.productName} is back in stock`,
        body: `${shelf.name}, ${shelf.village} (${Math.round(km * 10) / 10} km away) has it now. Reserve it before it goes again.`,
        refId: productId,
      });
      await unsubscribe(c, s.ownerId, productId);
      told += 1;
    }
    return told;
  });
};

const CONDITION_WORDS = {
  near_expiry: 'near its expiry date',
  opened: 'an opened pack',
  returned: 'returned stock',
  damaged_packaging: 'in damaged packaging',
  other: 'surplus stock',
};

// Called after an operator lists a surplus lot: tells the farmers who asked to
// hear about this product and are within range of the center. Unlike back in
// stock it does NOT end their subscription, because they still want the
// regular product; and it runs once per lot, so nobody hears about it twice.
// Returns how many farmers were told.
const notifyNewSurplus = async (db, { lotId }) => {
  const { rows: [lot] } = await db.query(
    `SELECT l.id, l.product_id AS "productId", l.unit_price AS "price", l.condition, l.quantity - l.reserved AS available,
            p.name AS "productName", p.price_in_rupees AS "catalogPrice", ce.name, ce.village, ce.latitude, ce.longitude
       FROM surplus_lot l JOIN products p ON p.id = l.product_id JOIN village_center ce ON ce.center_id = l.center_id
      WHERE l.id = $1 AND ${LOT_LIVE} AND ce.status = 'active' AND ce.operator_id IS NOT NULL`,
    [lotId],
  );
  if (!lot) return 0;
  const box = boundingBox(lot, NOTIFY_RADIUS_KM);
  const { rows: subs } = await db.query(
    `SELECT owner_id AS "ownerId", latitude, longitude FROM stock_subscription
      WHERE product_id = $1 AND latitude BETWEEN $2 AND $3 AND longitude BETWEEN $4 AND $5`,
    [lot.productId, box.minLat, box.maxLat, box.minLng, box.maxLng],
  );
  const off = Number(lot.catalogPrice) > 0 ? Math.round((1 - Number(lot.price) / Number(lot.catalogPrice)) * 100) : 0;
  let told = 0;
  for (const s of subs) {
    const km = haversineKm(lot, s);
    if (km > NOTIFY_RADIUS_KM) continue;
    await notify(db, s.ownerId, {
      type: 'stock',
      title: `${lot.productName} is ${off}% off near you`,
      body: `${lot.name}, ${lot.village} (${Math.round(km * 10) / 10} km away) has ${lot.available} at Rs ${Number(lot.price)} instead of Rs ${Number(lot.catalogPrice)}. It is ${CONDITION_WORDS[lot.condition] || 'surplus stock'}.`,
      refId: lot.productId,
    });
    told += 1;
  }
  return told;
};

module.exports = { subscribe, unsubscribe, isSubscribed, notifyBackInStock, notifyNewSurplus, NOTIFY_RADIUS_KM };
