const express = require('express');
const crypto = require('crypto');
const { HttpError, asyncHandler, str, num, body, sendPaged, likePattern } = require('../utils/http');
const { ORDER_COLUMNS, serializeOrder, newOrderId, findOrder, cancelOrder, withItems, insertOrder } = require('../services/orders');
const { otpLimiter } = require('../middleware/security');
const { notify } = require('../services/notifications');
const config = require('../config');

const ORDER_STATUSES = ['pending', 'readyForPickup', 'completed', 'cancelled'];
const ORDER_TYPES = ['appOrder', 'walkIn'];

const FARMER_COLUMNS = `id, name, village, phone, active_crop AS "activeCrop", last_visit_date AS "lastVisitDate",
  needs_follow_up AS "needsFollowUp", notes`;
const ITEM_COLUMNS = `id, name, unit, unit_price AS "unitPrice", current_stock AS "currentStock",
  low_stock_threshold AS "lowStockThreshold", (current_stock <= low_stock_threshold) AS "isLowStock"`;
const RESTOCK_COLUMNS = `id, item_id AS "itemId", item_name AS "itemName", requested_quantity AS "requestedQuantity",
  status, requested_date AS "requestedDate"`;

// The village-center (operator) API. There is one center, so this data is
// global rather than per-owner.
module.exports = (db) => {
  const router = express.Router();
  const ah = asyncHandler;
  const view = (order) => serializeOrder(order, { includeOtp: false });

  // ---- Farmers ----
  router.get('/farmers', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.needsFollowUp !== undefined) {
      params.push(String(req.query.needsFollowUp) === 'true');
      where.push(`needs_follow_up = $${params.length}`);
    }
    if (req.query.q) {
      params.push(likePattern(req.query.q));
      where.push(`(name || ' ' || village || ' ' || active_crop) ILIKE $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: FARMER_COLUMNS,
      from: `farmers${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'seq',
    });
  }));

  router.get('/farmers/:id', ah(async (req, res) => {
    const { rows } = await db.query(`SELECT ${FARMER_COLUMNS} FROM farmers WHERE id = $1`, [req.params.id]);
    if (!rows.length) throw new HttpError(404, 'Farmer not found');
    res.json(rows[0]);
  }));

  // ---- Orders ----
  router.get('/orders', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      if (!ORDER_STATUSES.includes(req.query.status)) throw new HttpError(400, `"status" must be one of: ${ORDER_STATUSES.join(', ')}`);
      params.push(req.query.status);
      where.push(`status = $${params.length}`);
    }
    if (req.query.type) {
      if (!ORDER_TYPES.includes(req.query.type)) throw new HttpError(400, `"type" must be one of: ${ORDER_TYPES.join(', ')}`);
      params.push(req.query.type);
      where.push(`type = $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: ORDER_COLUMNS,
      from: `orders${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'created_at DESC, id',
      finish: async (rows) => (await withItems(db, rows)).map(view),
    });
  }));

  router.post('/orders/walk-in', ah(async (req, res) => {
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
      ownerId: null,
    };
    await db.tx((c) => insertOrder(c, order));
    res.status(201).json(view(order));
  }));

  router.get('/orders/:id', ah(async (req, res) => res.json(view(await findOrder(db, req.params.id)))));

  router.post('/orders/:id/ready', ah(async (req, res) => {
    const order = await db.tx(async (c) => {
      const current = await findOrder(c, req.params.id, { lock: true });
      if (current.status === 'pending') {
        await c.query("UPDATE orders SET status = 'readyForPickup' WHERE id = $1", [current.id]);
        await notify(c, current.ownerId, {
          type: 'order',
          title: 'Your order is ready for pickup',
          body: `Show pickup code ${current.pickupOtp} at the village center to collect it.`,
          refId: current.id,
        });
        return { ...current, status: 'readyForPickup' };
      }
      if (current.status !== 'readyForPickup') throw new HttpError(409, `A ${current.status} order cannot be marked ready for pickup`);
      return current;
    });
    res.json(view(order));
  }));

  router.post('/orders/:id/verify-otp', otpLimiter, ah(async (req, res) => {
    const otp = str(body(req).otp, 'otp', { min: 4, max: 4 });
    const order = await db.tx(async (c) => {
      const current = await findOrder(c, req.params.id, { lock: true });
      if (current.status !== 'readyForPickup') throw new HttpError(409, 'This order is not ready for pickup yet');

      const expected = Buffer.from(current.pickupOtp || '');
      const given = Buffer.from(otp);
      const match = expected.length === given.length && crypto.timingSafeEqual(expected, given);
      if (!match) throw new HttpError(400, 'Incorrect OTP — please check with the farmer and try again.');

      await c.query("UPDATE orders SET status = 'completed', pickup_otp = NULL WHERE id = $1", [current.id]);
      await notify(c, current.ownerId, {
        type: 'order',
        title: 'Order collected',
        body: 'Thank you! Your order has been handed over.',
        refId: current.id,
      });
      return { ...current, status: 'completed', pickupOtp: null };
    });
    res.json(view(order));
  }));

  router.post('/orders/:id/cancel', ah(async (req, res) => {
    const order = await cancelOrder(db, req.params.id, (c, current) =>
      notify(c, current.ownerId, {
        type: 'order',
        title: 'Your order was cancelled',
        body: 'The village center cancelled this order. Contact them if you have questions.',
        refId: current.id,
      }),
    );
    res.json(view(order));
  }));

  // ---- Inventory ----
  router.get('/inventory/items', ah(async (req, res) => {
    await sendPaged(req, res, db, { select: ITEM_COLUMNS, from: 'inventory_items', order: 'seq' });
  }));

  router.get('/inventory/restock-requests', ah(async (req, res) => {
    await sendPaged(req, res, db, { select: RESTOCK_COLUMNS, from: 'restock_requests', order: 'requested_date DESC, id' });
  }));

  router.post('/inventory/restock-requests', ah(async (req, res) => {
    const input = body(req);
    const itemId = str(input.itemId, 'itemId', { max: 100 });
    const quantity = num(input.quantity, 'quantity', { min: 1, max: 100000, integer: true });
    const item = (await db.query('SELECT id, name FROM inventory_items WHERE id = $1', [itemId])).rows[0];
    if (!item) throw new HttpError(404, 'Inventory item not found');
    const { rows } = await db.query(
      `INSERT INTO restock_requests (id, item_id, item_name, requested_quantity, status) VALUES ($1,$2,$3,$4,'pending') RETURNING ${RESTOCK_COLUMNS}`,
      [`restock-${crypto.randomUUID()}`, item.id, item.name, quantity],
    );
    res.status(201).json(rows[0]);
  }));

  // ---- Earnings ----
  router.get('/earnings/commission-rate', (req, res) => {
    res.json({ commissionRatePercent: config.commissionRatePercent });
  });

  // Commission is earned on completed orders only, matching the app's math.
  // "Today" and "this month" use the server's local time.
  router.get('/earnings/summary', ah(async (req, res) => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const { rows } = await db.query(
      `SELECT
         COALESCE(SUM(oi.quantity * oi.unit_price) FILTER (WHERE o.created_at >= $1), 0) AS today,
         COALESCE(SUM(oi.quantity * oi.unit_price) FILTER (WHERE o.created_at >= $2), 0) AS month
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status = 'completed'`,
      [startOfDay, startOfMonth],
    );
    const rate = config.commissionRatePercent;
    const todaySales = rows[0].today;
    const monthSales = rows[0].month;
    res.json({
      commissionRatePercent: rate,
      todaySales,
      monthSales,
      todayCommission: (todaySales * rate) / 100,
      monthCommission: (monthSales * rate) / 100,
    });
  }));

  return router;
};
