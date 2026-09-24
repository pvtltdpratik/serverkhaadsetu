const { HttpError } = require('../utils/http');
const { newOrderId, newOtp, insertOrder } = require('./orders');
const { tryReserve, reserveLots } = require('./reservations');
const { LOT_LIVE } = require('./surplus');
const { findNearby } = require('./nearbyCenters');
const { notify } = require('./notifications');
const { checkLowStock } = require('./stockAlerts');
const { SERVICEABLE } = require('./centerService');
const { createForOrder } = require('./deliveryJobs');
const { roadKm } = require('./deliveryFee');
const { haversineKm } = require('./geo');
const config = require('../config');

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
//   lines   [{productId, quantity}] for regular stock, or [{surplusLotId, quantity}]
//           for a discounted surplus lot. A surplus lot exists only at the center
//           that listed it, so an order with one goes to that center (and any
//           regular lines in the same cart must be available there too).
//   origin  {latitude, longitude} of the farmer, or null
//   delivery  null for collection at the center, or {latitude, longitude, phone, label?, village?, note?}
//           to have a delivery partner bring it. The fee is worked out here, never taken from the client.
const placeAppOrder = async (db, { owner, customerName, lines, centerId, origin, homeCenterId, timeZone, now = new Date(), delivery = null }) => {
  return db.tx(async (c) => {
    // Prices always come from the catalog (or the surplus lot); never trust a
    // client-supplied price.
    const { rows: products } = await c.query(
      'SELECT id, name, price_in_rupees AS "price" FROM products WHERE id = ANY($1)',
      [lines.filter((l) => !l.surplusLotId).map((l) => l.productId)],
    );
    const byId = new Map(products.map((p) => [p.id, p]));
    const lotIds = [...new Set(lines.filter((l) => l.surplusLotId).map((l) => l.surplusLotId))];
    const { rows: lots } = lotIds.length
      ? await c.query(
        `SELECT l.id, l.center_id AS "centerId", l.product_id AS "productId", l.unit_price AS "price", p.name
           FROM surplus_lot l JOIN products p ON p.id = l.product_id WHERE l.id = ANY($1) AND ${LOT_LIVE}`, [lotIds])
      : { rows: [] };
    const lotById = new Map(lots.map((l) => [l.id, l]));

    const items = lines.map((l) => {
      if (l.surplusLotId) {
        const lot = lotById.get(l.surplusLotId);
        if (!lot) throw new HttpError(409, 'That surplus offer is no longer available.', { code: 'surplus_unavailable', surplusLotId: l.surplusLotId });
        return { productId: lot.productId, surplusLotId: lot.id, productName: lot.name, quantity: l.quantity, unitPrice: Number(lot.price) };
      }
      const product = byId.get(l.productId);
      if (!product) throw new HttpError(404, 'Product not found');
      return { productId: product.id, productName: product.name, quantity: l.quantity, unitPrice: product.price };
    });
    const shelfItems = items.filter((i) => !i.surplusLotId);
    const lotItems = items.filter((i) => i.surplusLotId);
    const lotCenters = [...new Set(lots.map((l) => l.centerId))];
    if (lotCenters.length > 1) throw new HttpError(400, "Surplus offers from different centers can't be in one order.");
    if (lotCenters.length && centerId && centerId !== lotCenters[0]) {
      throw new HttpError(400, 'Surplus offers can only be collected from the center that listed them.');
    }

    // What the farmer is choosing between, best first. Without a location we
    // can only honour an explicit choice.
    const ranked = origin && shelfItems.length
      ? (await findNearby(c, { origin, items: shelfItems, homeCenterId, limit: 10, timeZone, now })).centers
      : [];

    const pinnedCenter = lotCenters[0] || centerId;
    let candidates;
    if (pinnedCenter) {
      const { rows } = await c.query(`SELECT 1 FROM village_center c WHERE c.center_id = $1 AND ${SERVICEABLE}`, [pinnedCenter]);
      if (!rows.length) throw new HttpError(404, 'Village center not found');
      candidates = [pinnedCenter];
    } else {
      if (!origin) throw new HttpError(400, 'Location needed: send latitude and longitude, or a village, or choose a center.');
      candidates = ranked.filter((r) => r.inventory.status === 'all').map((r) => r.center.centerId);
    }

    // A delivery can only start from a center within reach of the farm.
    if (delivery) {
      const { rows: spots } = await c.query('SELECT center_id AS "centerId", latitude, longitude FROM village_center WHERE center_id = ANY($1)', [candidates]);
      const near = new Set(spots.filter((s) => roadKm(haversineKm(s, delivery)) <= config.delivery.maxRoadKm).map((s) => s.centerId));
      candidates = candidates.filter((id) => near.has(id));
      if (!candidates.length) {
        throw new HttpError(400, `Home delivery is only available within ${config.delivery.maxRoadKm} km of a village center. You can collect it yourself instead.`, { code: 'delivery_too_far', maxRoadKm: config.delivery.maxRoadKm });
      }
    }

    let chosen = null;
    for (const id of candidates) {
      if (!shelfItems.length || await tryReserve(c, id, shelfItems)) {
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

    // If a lot just sold out this throws, and the shelf hold above rolls back with it.
    if (lotItems.length) await reserveLots(c, chosen, lotItems);
    await checkLowStock(c, chosen, shelfItems.map((i) => i.productId));

    const { rows: [center] } = await c.query(
      `SELECT center_id AS "centerId", name, village, phone, latitude, longitude, operator_id AS "operatorId" FROM village_center WHERE center_id = $1`, [chosen]);
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

    let job = null;
    if (delivery) {
      const goodsAmount = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
      job = await createForOrder(c, { order, center, items, delivery, goodsAmount, now, timeZone });
      order.fulfilment = 'delivery';
      order.deliveryFee = job.fee;
      order.pickupOtp = null; // the partner's handover code is used instead of a counter code
    }

    await notify(c, owner, {
      type: 'order',
      title: 'Order placed',
      body: job
        ? `We are finding a delivery partner. Delivery fee Rs ${job.fee}, paid in cash when it arrives. If nobody is free you can collect it at ${center.name}, ${center.village}.`
        : `Your pickup code is ${order.pickupOtp}. Collect it from ${center.name}, ${center.village} within ${RESERVATION_DAYS} days.`,
      refId: order.id,
    });
    // The operator learns about it immediately, with what to set aside.
    await notify(c, center.operatorId, {
      type: 'order',
      title: 'New app order',
      body: `${order.customerName}: ${items.map((i) => `${i.quantity} x ${i.productName}${i.surplusLotId ? ' (surplus)' : ''}`).join(', ')}. ${job ? 'A delivery partner will collect it: set it aside.' : 'Set it aside for pickup.'}`,
      refId: order.id,
    });

    return { order, center: { centerId: center.centerId, name: center.name, village: center.village, phone: center.phone } };
  });
};

module.exports = { placeAppOrder, RESERVATION_DAYS };
