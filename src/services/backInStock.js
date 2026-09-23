const { haversineKm, boundingBox } = require('./geo');
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

module.exports = { subscribe, unsubscribe, isSubscribed, notifyBackInStock, NOTIFY_RADIUS_KM };
