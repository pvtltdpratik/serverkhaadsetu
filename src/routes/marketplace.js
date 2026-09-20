const express = require('express');
const crypto = require('crypto');
const { HttpError, str, num, oneOf, body, deviceId, sendList } = require('../utils/http');
const { serializeOrder, newOrderId, newOtp, findOrder, cancelOrder } = require('../services/orders');
const { notify } = require('../services/notifications');

const CATEGORIES = ['fertilizer', 'organic', 'pesticide', 'seed', 'equipment'];
const NUTRIENTS = ['nitrogen', 'phosphorus', 'potassium'];

module.exports = (store) => {
  const router = express.Router();

  const productById = (id) => {
    const product = store.data.products.find((p) => p.id === id);
    if (!product) throw new HttpError(404, 'Product not found');
    return product;
  };

  router.get('/products', (req, res) => {
    let items = store.data.products;
    if (req.query.category) items = items.filter((p) => p.category === oneOf(req.query.category, 'category', CATEGORIES));
    if (req.query.nutrient) items = items.filter((p) => p.nutrientFocus.includes(oneOf(req.query.nutrient, 'nutrient', NUTRIENTS)));
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      items = items.filter((p) => `${p.name} ${p.brand} ${p.description}`.toLowerCase().includes(q));
    }
    sendList(req, res, items);
  });

  router.get('/products/:id', (req, res) => res.json(productById(req.params.id)));

  router.get('/products/:id/reviews', (req, res) => {
    productById(req.params.id);
    const reviews = store.data.reviews
      .filter((r) => r.productId === req.params.id)
      .sort((a, b) => b.date.localeCompare(a.date));
    sendList(req, res, reviews);
  });

  router.post('/products/:id/reviews', (req, res) => {
    const product = productById(req.params.id);
    const input = body(req);
    const review = {
      id: `review-${crypto.randomUUID()}`,
      productId: product.id,
      authorName: str(input.authorName, 'authorName', { max: 60 }),
      rating: num(input.rating, 'rating', { min: 1, max: 5, integer: true }),
      comment: str(input.comment, 'comment', { max: 1000 }),
      date: new Date().toISOString(),
    };
    product.rating = Math.round(((product.rating * product.reviewCount + review.rating) / (product.reviewCount + 1)) * 10) / 10;
    product.reviewCount += 1;
    store.data.reviews.push(review);
    store.save();
    res.status(201).json(review);
  });

  // ---- Farmer-side orders (what the village center later sees as "app orders") ----

  const ownOrder = (req) => {
    const order = findOrder(store, req.params.id);
    if (order.deviceId !== deviceId(req)) throw new HttpError(404, 'Order not found');
    return order;
  };

  router.post('/orders', (req, res) => {
    const device = deviceId(req);
    const input = body(req);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) {
      throw new HttpError(400, '"items" must be an array of 1-50 entries');
    }
    // Prices always come from the catalog — never trust a client-supplied price.
    const items = input.items.map((raw, i) => {
      if (!raw || typeof raw !== 'object') throw new HttpError(400, `items[${i}] must be an object`);
      const product = productById(str(raw.productId, `items[${i}].productId`, { max: 100 }));
      return {
        productName: product.name,
        quantity: num(raw.quantity, `items[${i}].quantity`, { min: 1, max: 100, integer: true }),
        unitPrice: product.priceInRupees,
      };
    });
    const profile = store.data.profiles.find((p) => p.deviceId === device);
    const order = {
      id: newOrderId(),
      customerName: str(input.customerName, 'customerName', { max: 80, optional: true }) || profile?.name || 'Farmer',
      type: 'appOrder',
      status: 'pending',
      items,
      createdAt: new Date().toISOString(),
      pickupOtp: newOtp(),
      deviceId: device,
    };
    store.data.orders.push(order);
    notify(store, device, {
      type: 'order',
      title: 'Order placed',
      body: `Your pickup code is ${order.pickupOtp}. We will tell you when it is ready.`,
      refId: order.id,
    });
    store.save();
    res.status(201).json(serializeOrder(order, { includeOtp: true }));
  });

  router.get('/orders', (req, res) => {
    const device = deviceId(req);
    const mine = store.data.orders
      .filter((o) => o.deviceId === device)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((o) => serializeOrder(o, { includeOtp: true }));
    sendList(req, res, mine);
  });

  router.get('/orders/:id', (req, res) => res.json(serializeOrder(ownOrder(req), { includeOtp: true })));

  router.post('/orders/:id/cancel', (req, res) => {
    const order = ownOrder(req);
    cancelOrder(store, order);
    res.json(serializeOrder(order, { includeOtp: true }));
  });

  return router;
};
