const express = require('express');
const crypto = require('crypto');
const { HttpError, asyncHandler, str, num, oneOf, body, deviceId, sendPaged, likePattern } = require('../utils/http');
const { ORDER_COLUMNS, serializeOrder, findOrder, cancelOrder, withItems } = require('../services/orders');
const { placeAppOrder } = require('../services/orderPlacement');
const { resolveOrigin } = require('../services/location');
const config = require('../config');
const { notify } = require('../services/notifications');

const CATEGORIES = ['fertilizer', 'organic', 'pesticide', 'seed', 'equipment'];
const NUTRIENTS = ['nitrogen', 'phosphorus', 'potassium'];

const PRODUCT_COLUMNS = `id, name, brand, category, price_in_rupees AS "priceInRupees", unit_label AS "unitLabel",
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

  router.post('/orders', ah(async (req, res) => {
    const owner = deviceId(req);
    const input = body(req);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) {
      throw new HttpError(400, '"items" must be an array of 1-50 entries');
    }
    const lines = input.items.map((raw, i) => {
      if (!raw || typeof raw !== 'object') throw new HttpError(400, `items[${i}] must be an object`);
      return {
        productId: str(raw.productId, `items[${i}].productId`, { max: 100 }),
        quantity: num(raw.quantity, `items[${i}].quantity`, { min: 1, max: 100, integer: true }),
      };
    });
    const customerName = str(input.customerName, 'customerName', { max: 80, optional: true });
    // The farmer may pick a center; otherwise the best one that has everything
    // is chosen from where they are (GPS/pin/village, or their saved location).
    const centerId = str(input.centerId, 'centerId', { max: 100, optional: true });
    const located = await resolveOrigin(db, owner, input);

    const { order, center } = await placeAppOrder(db, {
      owner,
      customerName,
      lines,
      centerId,
      origin: located ? located.origin : null,
      homeCenterId: located ? located.profile.homeCenterId : null,
      timeZone: config.centerTimezone,
    });
    res.status(201).json({ ...serializeOrder(order, { includeOtp: true }), center });
  }));

  router.get('/orders', ah(async (req, res) => {
    await sendPaged(req, res, db, {
      select: ORDER_COLUMNS,
      from: 'orders WHERE owner_id = $1',
      params: [deviceId(req)],
      order: 'created_at DESC, id',
      finish: async (rows) => (await withItems(db, rows)).map((o) => serializeOrder(o, { includeOtp: true })),
    });
  }));

  router.get('/orders/:id', ah(async (req, res) => res.json(serializeOrder(await ownOrder(req), { includeOtp: true }))));

  router.post('/orders/:id/cancel', ah(async (req, res) => {
    await ownOrder(req); // 404 unless it is this owner's
    const order = await cancelOrder(db, req.params.id);
    res.json(serializeOrder(order, { includeOtp: true }));
  }));

  return router;
};
