const express = require('express');
const crypto = require('crypto');
const { HttpError, asyncHandler, str, num, oneOf, body, deviceId, sendPaged, likePattern } = require('../utils/http');
const { ORDER_COLUMNS, serializeOrder, findOrder, cancelOrder, withItems } = require('../services/orders');
const { placeAppOrder } = require('../services/orderPlacement');
const { normalizePhone } = require('../services/deliveryPartner');
const { resolveOrigin } = require('../services/location');
const config = require('../config');
const { notify } = require('../services/notifications');
const { subscribe, unsubscribe, isSubscribed } = require('../services/backInStock');

const CATEGORIES = ['fertilizer', 'organic', 'pesticide', 'seed', 'equipment'];
const NUTRIENTS = ['nitrogen', 'phosphorus', 'potassium'];

const PRODUCT_COLUMNS = `id, name, brand, category, price_in_rupees AS "priceInRupees", unit_label AS "unitLabel", weight_kg AS "weightKg",
  rating, review_count AS "reviewCount", description, nutrient_focus AS "nutrientFocus", npk_percentages AS "npkPercentages"`;
const REVIEW_COLUMNS = 'id, product_id AS "productId", author_name AS "authorName", rating, comment, date';

module.exports = (db) => {
  const router = express.Router();
  const ah = asyncHandler;

  const productById = async (id, q = db) => {
    const { rows } = await q.query(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = $1`, [id]);
    if (!rows.length) throw new HttpError(404, 'Product not found');
    return rows[0];
  };

  router.get('/products', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.category) {
      params.push(oneOf(req.query.category, 'category', CATEGORIES));
      where.push(`category = $${params.length}`);
    }
    if (req.query.nutrient) {
      params.push(oneOf(req.query.nutrient, 'nutrient', NUTRIENTS));
      where.push(`$${params.length} = ANY(nutrient_focus)`);
    }
    if (req.query.q) {
      params.push(likePattern(req.query.q));
      where.push(`(name || ' ' || brand || ' ' || description) ILIKE $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: PRODUCT_COLUMNS,
      from: `products${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'seq',
    });
  }));

  router.get('/products/:id', ah(async (req, res) => res.json(await productById(req.params.id))));

  // ---- "Notify me when available" ----
  // Subscribing remembers WHERE the farmer asked from; when any center within
  // range receives the product they are told once and the subscription ends.
  router.get('/products/:id/notify-me', ah(async (req, res) => {
    await productById(req.params.id);
    res.json({ subscribed: await isSubscribed(db, deviceId(req), req.params.id) });
  }));

  router.put('/products/:id/notify-me', ah(async (req, res) => {
    await productById(req.params.id);
    const owner = deviceId(req);
    const located = await resolveOrigin(db, owner, body(req));
    if (!located) throw new HttpError(400, 'Location needed: send latitude and longitude, or a village, or set your village in your profile.');
    await subscribe(db, { ownerId: owner, productId: req.params.id, ...located.origin });
    res.json({ subscribed: true });
  }));

  router.delete('/products/:id/notify-me', ah(async (req, res) => {
    await productById(req.params.id);
    await unsubscribe(db, deviceId(req), req.params.id);
    res.json({ subscribed: false });
  }));

  router.get('/products/:id/reviews', ah(async (req, res) => {
    await productById(req.params.id);
    await sendPaged(req, res, db, {
      select: REVIEW_COLUMNS, from: 'reviews WHERE product_id = $1', params: [req.params.id], order: 'date DESC, id',
    });
  }));

  router.post('/products/:id/reviews', ah(async (req, res) => {
    const input = body(req);
    const review = await db.tx(async (c) => {
      const product = await productById(req.params.id, c);
      const row = {
        id: `review-${crypto.randomUUID()}`,
        productId: product.id,
        authorName: str(input.authorName, 'authorName', { max: 60 }),
        rating: num(input.rating, 'rating', { min: 1, max: 5, integer: true }),
        comment: str(input.comment, 'comment', { max: 1000 }),
      };
      const { rows } = await c.query(
        `INSERT INTO reviews (id, product_id, author_name, rating, comment) VALUES ($1,$2,$3,$4,$5) RETURNING ${REVIEW_COLUMNS}`,
        [row.id, row.productId, row.authorName, row.rating, row.comment],
      );
      // One statement, so concurrent reviews can't lose an update.
      await c.query(
        'UPDATE products SET rating = ROUND((rating * review_count + $2) / (review_count + 1), 1), review_count = review_count + 1 WHERE id = $1',
        [product.id, row.rating],
      );
      return rows[0];
    });
    res.status(201).json(review);
  }));

  // ---- Farmer-side orders (what the village center later sees as "app orders") ----

  const ownOrder = async (req, q = db) => {
    const order = await findOrder(q, req.params.id);
    if (order.ownerId !== deviceId(req)) throw new HttpError(404, 'Order not found');
    return order;
  };

  // Attaches where each order is to be collected, so the app can show the
  // place and offer a call button without a second request.
  const withCenter = async (orders) => {
    const ids = [...new Set(orders.map((o) => o.centerId).filter(Boolean))];
    if (!ids.length) return orders.map((o) => ({ ...o, center: null }));
    const { rows } = await db.query(
      'SELECT center_id AS "centerId", name, village, phone FROM village_center WHERE center_id = ANY($1)', [ids]);
    const byId = new Map(rows.map((c) => [c.centerId, c]));
    return orders.map((o) => ({ ...o, center: byId.get(o.centerId) || null }));
  };
  const farmerView = async (orders) => (await withCenter(orders)).map((o) => ({ ...serializeOrder(o, { includeOtp: true }), center: o.center }));

  router.post('/orders', ah(async (req, res) => {
    const owner = deviceId(req);
    const input = body(req);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) {
      throw new HttpError(400, '"items" must be an array of 1-50 entries');
    }
    const lines = input.items.map((raw, i) => {
      if (!raw || typeof raw !== 'object') throw new HttpError(400, `items[${i}] must be an object`);
      const surplusLotId = str(raw.surplusLotId, `items[${i}].surplusLotId`, { max: 100, optional: true });
      return {
        // A surplus line names its lot; the product and price come from the lot.
        productId: surplusLotId ? undefined : str(raw.productId, `items[${i}].productId`, { max: 100 }),
        surplusLotId,
        quantity: num(raw.quantity, `items[${i}].quantity`, { min: 1, max: 100, integer: true }),
      };
    });
    const customerName = str(input.customerName, 'customerName', { max: 80, optional: true });
    // The farmer may pick a center; otherwise the best one that has everything
    // is chosen from where they are (GPS/pin/village, or their saved location).
    const centerId = str(input.centerId, 'centerId', { max: 100, optional: true });
    const located = await resolveOrigin(db, owner, input);

    // Collect it yourself (the default), or have a delivery partner bring it.
    const fulfilment = input.fulfilment === undefined ? 'pickup' : oneOf(input.fulfilment, 'fulfilment', ['pickup', 'delivery']);
    let delivery = null;
    if (fulfilment === 'delivery') {
      const a = input.deliveryAddress;
      if (!a || typeof a !== 'object' || Array.isArray(a)) throw new HttpError(400, '"deliveryAddress" is required for home delivery');
      const profile = (await db.query('SELECT village FROM profiles WHERE owner_id = $1', [owner])).rows[0];
      delivery = {
        latitude: num(a.latitude, 'deliveryAddress.latitude', { min: -90, max: 90 }),
        longitude: num(a.longitude, 'deliveryAddress.longitude', { min: -180, max: 180 }),
        phone: normalizePhone(a.phone),
        label: str(a.label, 'deliveryAddress.label', { max: 200, optional: true }) || '',
        note: str(a.note, 'deliveryAddress.note', { max: 300, optional: true }) || '',
        village: str(a.village, 'deliveryAddress.village', { max: 120, optional: true }) || profile?.village || '',
      };
    }

    const { order, center } = await placeAppOrder(db, {
      owner,
      customerName,
      lines,
      centerId,
      // With a delivery the farm itself is the best guide to which center is near.
      origin: located ? located.origin : delivery ? { latitude: delivery.latitude, longitude: delivery.longitude } : null,
      homeCenterId: located ? located.profile.homeCenterId : null,
      timeZone: config.centerTimezone,
      delivery,
    });
    res.status(201).json({ ...serializeOrder(order, { includeOtp: true }), center });
  }));

  router.get('/orders', ah(async (req, res) => {
    await sendPaged(req, res, db, {
      select: ORDER_COLUMNS,
      from: 'orders WHERE owner_id = $1',
      params: [deviceId(req)],
      order: 'created_at DESC, id',
      finish: async (rows) => farmerView(await withItems(db, rows)),
    });
  }));

  router.get('/orders/:id', ah(async (req, res) => res.json((await farmerView([await ownOrder(req)]))[0])));

  router.post('/orders/:id/cancel', ah(async (req, res) => {
    await ownOrder(req); // 404 unless it is this owner's
    const order = await cancelOrder(db, req.params.id);
    res.json((await farmerView([order]))[0]);
  }));

  return router;
};
