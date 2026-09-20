const express = require('express');
const crypto = require('crypto');
const { HttpError, str, num, body, sendList } = require('../utils/http');
const { serializeOrder, newOrderId, findOrder, cancelOrder } = require('../services/orders');
const { otpLimiter } = require('../middleware/security');
const config = require('../config');

const ORDER_STATUSES = ['pending', 'readyForPickup', 'completed', 'cancelled'];
const ORDER_TYPES = ['appOrder', 'walkIn'];

// The village-center (operator) API. There is one center, so this data is
// global rather than per-device.
module.exports = (store) => {
  const router = express.Router();
  const view = (order) => serializeOrder(order, { includeOtp: false });

  // ---- Farmers ----
  router.get('/farmers', (req, res) => {
    let farmers = store.data.farmers;
    if (req.query.needsFollowUp !== undefined) {
      const want = String(req.query.needsFollowUp) === 'true';
      farmers = farmers.filter((f) => f.needsFollowUp === want);
    }
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      farmers = farmers.filter((f) => `${f.name} ${f.village} ${f.activeCrop}`.toLowerCase().includes(q));
    }
    sendList(req, res, farmers);
  });

  router.get('/farmers/:id', (req, res) => {
    const farmer = store.data.farmers.find((f) => f.id === req.params.id);
    if (!farmer) throw new HttpError(404, 'Farmer not found');
    res.json(farmer);
  });

  // ---- Orders ----
  router.get('/orders', (req, res) => {
    let orders = store.data.orders;
    if (req.query.status) orders = orders.filter((o) => o.status === req.query.status);
    if (req.query.type) orders = orders.filter((o) => o.type === req.query.type);
    if (req.query.status && !ORDER_STATUSES.includes(req.query.status)) throw new HttpError(400, `"status" must be one of: ${ORDER_STATUSES.join(', ')}`);
    if (req.query.type && !ORDER_TYPES.includes(req.query.type)) throw new HttpError(400, `"type" must be one of: ${ORDER_TYPES.join(', ')}`);
    sendList(req, res, [...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(view));
  });

  router.post('/orders/walk-in', (req, res) => {
    const input = body(req);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) {
      throw new HttpError(400, '"items" must be an array of 1-50 entries');
    }
    const items = input.items.map((raw, i) => {
      if (!raw || typeof raw !== 'object') throw new HttpError(400, `items[${i}] must be an object`);
      return {
        productName: str(raw.productName, `items[${i}].productName`, { max: 120 }),
        quantity: num(raw.quantity, `items[${i}].quantity`, { min: 1, max: 10000, integer: true }),
        unitPrice: num(raw.unitPrice, `items[${i}].unitPrice`, { min: 0, max: 10000000 }),
      };
    });
    const order = {
      id: newOrderId(),
      customerName: str(input.customerName, 'customerName', { max: 80, optional: true }) || 'Walk-in customer',
      type: 'walkIn',
      status: 'completed',
      items,
      createdAt: new Date().toISOString(),
      pickupOtp: null,
      deviceId: null,
    };
    store.data.orders.push(order);
    store.save();
    res.status(201).json(view(order));
  });

  router.get('/orders/:id', (req, res) => res.json(view(findOrder(store, req.params.id))));

  router.post('/orders/:id/ready', (req, res) => {
    const order = findOrder(store, req.params.id);
    if (order.status === 'pending') {
      order.status = 'readyForPickup';
      store.save();
    } else if (order.status !== 'readyForPickup') {
      throw new HttpError(409, `A ${order.status} order cannot be marked ready for pickup`);
    }
    res.json(view(order));
  });

  router.post('/orders/:id/verify-otp', otpLimiter, (req, res) => {
    const order = findOrder(store, req.params.id);
    const otp = str(body(req).otp, 'otp', { min: 4, max: 4 });
    if (order.status !== 'readyForPickup') throw new HttpError(409, 'This order is not ready for pickup yet');

    const expected = Buffer.from(order.pickupOtp || '');
    const given = Buffer.from(otp);
    const match = expected.length === given.length && crypto.timingSafeEqual(expected, given);
    if (!match) throw new HttpError(400, 'Incorrect OTP — please check with the farmer and try again.');

    order.status = 'completed';
    order.pickupOtp = null;
    store.save();
    res.json(view(order));
  });

  router.post('/orders/:id/cancel', (req, res) => {
    const order = findOrder(store, req.params.id);
    cancelOrder(store, order);
    res.json(view(order));
  });

  // ---- Inventory ----
  router.get('/inventory/items', (req, res) => {
    sendList(req, res, store.data.inventory.map((i) => ({ ...i, isLowStock: i.currentStock <= i.lowStockThreshold })));
  });

  router.get('/inventory/restock-requests', (req, res) => {
    sendList(req, res, [...store.data.restockRequests].sort((a, b) => b.requestedDate.localeCompare(a.requestedDate)));
  });

  router.post('/inventory/restock-requests', (req, res) => {
    const input = body(req);
    const item = store.data.inventory.find((i) => i.id === str(input.itemId, 'itemId', { max: 100 }));
    if (!item) throw new HttpError(404, 'Inventory item not found');
    const request = {
      id: `restock-${crypto.randomUUID()}`,
      itemId: item.id,
      itemName: item.name,
      requestedQuantity: num(input.quantity, 'quantity', { min: 1, max: 100000, integer: true }),
      status: 'pending',
      requestedDate: new Date().toISOString(),
    };
    store.data.restockRequests.push(request);
    store.save();
    res.status(201).json(request);
  });

  // ---- Earnings ----
  router.get('/earnings/commission-rate', (req, res) => {
    res.json({ commissionRatePercent: config.commissionRatePercent });
  });

  // Commission is earned on completed orders only, matching the app's math.
  router.get('/earnings/summary', (req, res) => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const completed = store.data.orders.filter((o) => o.status === 'completed');
    const sales = (since) =>
      completed
        .filter((o) => new Date(o.createdAt).getTime() >= since)
        .reduce((sum, o) => sum + serializeOrder(o, { includeOtp: false }).totalAmount, 0);
    const rate = config.commissionRatePercent;
    const todaySales = sales(startOfDay);
    const monthSales = sales(startOfMonth);
    res.json({
      commissionRatePercent: rate,
      todaySales,
      monthSales,
      todayCommission: (todaySales * rate) / 100,
      monthCommission: (monthSales * rate) / 100,
    });
  });

  return router;
};
