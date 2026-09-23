const { HttpError } = require('../utils/http');
const { newOrderId, newOtp, insertOrder } = require('./orders');
const { tryReserve } = require('./reservations');
const { findNearby } = require('./nearbyCenters');
const { notify } = require('./notifications');

const RESERVATION_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const shortAlternatives = (ranked) =>
  ranked.slice(0, 5).map((c) => ({
    centerId: c.center.centerId, name: c.center.name, village: c.center.village, distanceKm: c.distanceKm,
    inventoryStatus: c.inventory.status, inventoryLabel: c.inventory.label,
  }));

// Places a farmer's app order and holds its stock, in one transaction.
//
// Which center: the farmer's own choice (`centerId`), otherwise the best-ranked
// center near them that can cover the WHOLE cart. Holding is atomic per line,
// so if two farmers race for the last unit the loser is not oversold: with
// automatic assignment they fall through to the next-ranked center, with an
// explicit choice they get a 409 that lists the alternatives.
//
//   lines   [{productId, quantity}]
//   origin  {latitude, longitude} of the farmer, or null
const placeAppOrder = async (db, { owner, customerName, lines, centerId, origin, homeCenterId, timeZone, now = new Date() }) => {
  return db.tx(async (c) => {
    // Prices always come from the catalog; never trust a client-supplied price.
    const { rows: products } = await c.query(
      'SELECT id, name, price_in_rupees AS "price" FROM products WHERE id = ANY($1)',
      [lines.map((l) => l.productId)],
    );
    const byId = new Map(products.map((p) => [p.id, p]));
    const items = lines.map((l) => {
      const product = byId.get(l.productId);
      if (!product) throw new HttpError(404, 'Product not found');
      return { productId: product.id, productName: product.name, quantity: l.quantity, unitPrice: product.price };
    });

    // What the farmer is choosing between, best first. Without a location we
    // can only honour an explicit choice.
    const ranked = origin
      ? (await findNearby(c, { origin, items, homeCenterId, limit: 10, timeZone, now })).centers
      : [];

    let candidates;
    if (centerId) {
      const { rows } = await c.query("SELECT 1 FROM village_center WHERE center_id = $1 AND status = 'active' AND operator_id IS NOT NULL", [centerId]);
      if (!rows.length) throw new HttpError(404, 'Village center not found');
      candidates = [centerId];
    } else {
      if (!origin) throw new HttpError(400, 'Location needed: send latitude and longitude, or a village, or choose a center.');
      candidates = ranked.filter((r) => r.inventory.status === 'all').map((r) => r.center.centerId);
    }

    let chosen = null;
    for (const id of candidates) {
      if (await tryReserve(c, id, items)) {
        chosen = id;
        break;
      }
    }
    if (!chosen) {
      const message = centerId
        ? 'That center just went out of stock of one or more items. Please choose another center.'
        : 'None of the centers near you have all of these items right now.';
      // Re-rank now (without a lock) so the alternatives reflect what is left.
      throw new HttpError(409, message, { code: 'out_of_stock', alternatives: shortAlternatives(ranked.filter((r) => r.center.centerId !== centerId)) });
    }

    const { rows: [center] } = await c.query(
      `SELECT center_id AS "centerId", name, village, phone, operator_id AS "operatorId" FROM village_center WHERE center_id = $1`, [chosen]);
    const profile = (await c.query('SELECT name FROM profiles WHERE owner_id = $1', [owner])).rows[0];
    const order = {
      id: newOrderId(),
      customerName: customerName || profile?.name || 'Farmer',
      type: 'appOrder',
      status: 'pending',
      items,
      createdAt: now.toISOString(),
      pickupOtp: newOtp(),
      ownerId: owner,
      centerId: chosen,
      stockReserved: true,
      reservedUntil: new Date(now.getTime() + RESERVATION_DAYS * DAY_MS).toISOString(),
      originLatitude: origin ? origin.latitude : null,
      originLongitude: origin ? origin.longitude : null,
    };
    await insertOrder(c, order);

    await notify(c, owner, {
      type: 'order',
      title: 'Order placed',
      body: `Your pickup code is ${order.pickupOtp}. Collect it from ${center.name}, ${center.village} within ${RESERVATION_DAYS} days.`,
      refId: order.id,
    });
    // The operator learns about it immediately, with what to set aside.
    await notify(c, center.operatorId, {
      type: 'order',
      title: 'New app order',
      body: `${order.customerName}: ${items.map((i) => `${i.quantity} x ${i.productName}`).join(', ')}. Set it aside for pickup.`,
      refId: order.id,
    });

    return { order, center: { centerId: center.centerId, name: center.name, village: center.village, phone: center.phone } };
  });
};

module.exports = { placeAppOrder, RESERVATION_DAYS };
