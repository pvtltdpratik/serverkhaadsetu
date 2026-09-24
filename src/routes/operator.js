const express = require('express');
const crypto = require('crypto');
const { HttpError, asyncHandler, str, num, oneOf, bool, isoDate, body, sendPaged, likePattern, deviceId } = require('../utils/http');
const { ORDER_COLUMNS, serializeOrder, newOrderId, findOrder, cancelOrder, withItems, insertOrder } = require('../services/orders');
const { otpLimiter } = require('../middleware/security');
const { notify } = require('../services/notifications');
const centers = require('../services/centerService');
const surplus = require('../services/surplus');
const partners = require('../services/deliveryPartner');
const { deductWalkIn, deductWalkInLots, consumeOrderStock } = require('../services/reservations');
const { checkLowStock } = require('../services/stockAlerts');
const { notifyBackInStock, notifyNewSurplus } = require('../services/backInStock');
const config = require('../config');

const ORDER_STATUSES = ['pending', 'readyForPickup', 'completed', 'cancelled'];
const ORDER_TYPES = ['appOrder', 'walkIn'];

const RESTOCK_COLUMNS = `r.id, r.product_id AS "itemId", p.name AS "itemName", r.requested_quantity AS "requestedQuantity",
  r.status, r.requested_date AS "requestedDate"`;

// The village-center (operator) API. Every route here is scoped to the
// caller's own center (`req.center`, set by requireOperator): an operator can
// never see or touch another center's orders, stock or farmers.
module.exports = (db, roles) => {
  const router = express.Router();
  const ah = asyncHandler;
  router.use(roles.requireOperator);
  const view = (order) => serializeOrder(order, { includeOtp: false });

  // An order that belongs to another center (or to none yet) is a 404, not a 403.
  const ownCenterOrder = (req, order) => {
    if (order.centerId !== req.center.centerId) throw new HttpError(404, 'Order not found');
    return order;
  };

  // ---- My center ----
  router.get('/center', ah(async (req, res) => res.json(await centers.findCenter(db, req.center.centerId))));

  // The operator's own switches: open/closed, hours, contact. Location and
  // status are the platform admin's to change.
  router.patch('/center', ah(async (req, res) => {
    const input = body(req);
    const changes = {};
    if (input.isOpen !== undefined) {
      if (typeof input.isOpen !== 'boolean') throw new HttpError(400, '"isOpen" must be true or false');
      changes.isOpen = input.isOpen;
    }
    for (const field of ['opensAt', 'closesAt']) {
      if (input[field] === undefined) continue;
      if (typeof input[field] !== 'string' || !centers.TIME.test(input[field])) throw new HttpError(400, `"${field}" must be a time like 09:30`);
      changes[field] = input[field];
    }
    if (input.phone !== undefined) changes.phone = str(input.phone, 'phone', { max: 30, optional: true }) || '';
    if (input.operatorName !== undefined) changes.operatorName = str(input.operatorName, 'operatorName', { max: 120, optional: true }) || '';
    res.json(await centers.updateCenter(db, req.center.centerId, changes));
  }));

  // ---- Farmers ----
  // Built from the real customers who have ordered at this center: each farmer
  // with an app order (cancelled ones don't count), their last order, and how
  // many they have placed. `needsFollowUp` means no order for 30 days.
  const FARMERS_FROM = `(
    SELECT o.owner_id AS id,
           COALESCE(NULLIF(p.name, ''), (array_agg(o.customer_name ORDER BY o.created_at DESC))[1]) AS name,
           COALESCE(p.village, '') AS village,
           '' AS phone, '' AS "activeCrop", '' AS notes,
           max(o.created_at) AS "lastVisitDate",
           count(*)::int AS "ordersCount",
           (max(o.created_at) < now() - interval '30 days') AS "needsFollowUp"
      FROM orders o LEFT JOIN profiles p ON p.owner_id = o.owner_id
     WHERE o.center_id = $1 AND o.owner_id IS NOT NULL AND o.status <> 'cancelled'
     GROUP BY o.owner_id, p.name, p.village) f`;

  router.get('/farmers', ah(async (req, res) => {
    const params = [req.center.centerId];
    const where = [];
    if (req.query.needsFollowUp !== undefined) {
      params.push(String(req.query.needsFollowUp) === 'true');
      where.push(`f."needsFollowUp" = $${params.length}`);
    }
    if (req.query.q) {
      params.push(likePattern(req.query.q));
      where.push(`(f.name || ' ' || f.village) ILIKE $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: 'f.*',
      from: `${FARMERS_FROM}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'f."lastVisitDate" DESC, f.id',
    });
  }));

  router.get('/farmers/:id', ah(async (req, res) => {
    const { rows } = await db.query(`SELECT f.* FROM ${FARMERS_FROM} WHERE f.id = $2`, [req.center.centerId, req.params.id]);
    if (!rows.length) throw new HttpError(404, 'Farmer not found');
    res.json(rows[0]);
  }));

  // ---- Orders ----
  router.get('/orders', ah(async (req, res) => {
    const params = [req.center.centerId];
    const where = ['center_id = $1'];
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
      from: `orders WHERE ${where.join(' AND ')}`,
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
    const lines = input.items.map((raw, i) => {
      if (!raw || typeof raw !== 'object') throw new HttpError(400, `items[${i}] must be an object`);
      return {
        productId: str(raw.productId, `items[${i}].productId`, { max: 100, optional: true }),
        productName: str(raw.productName, `items[${i}].productName`, { max: 120, optional: true }),
        // A line can be a surplus lot's units instead of shelf stock; its price then defaults to the lot's.
        surplusLotId: str(raw.surplusLotId, `items[${i}].surplusLotId`, { max: 100, optional: true }),
        quantity: num(raw.quantity, `items[${i}].quantity`, { min: 1, max: 10000, integer: true }),
        unitPrice: raw.unitPrice === undefined && raw.surplusLotId ? undefined : num(raw.unitPrice, `items[${i}].unitPrice`, { min: 0, max: 10000000 }),
        index: i,
      };
    });
    const order = await db.tx(async (c) => {
      // Every line must be a real catalog product (by id, or by exact name for
      // older clients): that is what lets the sale come off this center's shelf.
      const items = [];
      for (const line of lines) {
        if (line.surplusLotId) {
          const { rows: [lot] } = await c.query(
            `SELECT l.product_id AS "productId", l.unit_price AS "price", p.name FROM surplus_lot l JOIN products p ON p.id = l.product_id
              WHERE l.id = $1 AND l.center_id = $2`, [line.surplusLotId, req.center.centerId]);
          if (!lot) throw new HttpError(404, 'Surplus lot not found');
          items.push({
            productId: lot.productId, surplusLotId: line.surplusLotId, productName: lot.name, quantity: line.quantity,
            unitPrice: line.unitPrice === undefined ? Number(lot.price) : line.unitPrice,
          });
          continue;
        }
        if (!line.productId && !line.productName) throw new HttpError(400, `items[${line.index}] needs a "productId"`);
        const { rows } = line.productId
          ? await c.query('SELECT id, name FROM products WHERE id = $1', [line.productId])
          : await c.query('SELECT id, name FROM products WHERE lower(name) = lower($1)', [line.productName]);
        if (!rows.length) throw new HttpError(line.productId ? 404 : 400, `Unknown product "${line.productId || line.productName}"`);
        items.push({ productId: rows[0].id, productName: rows[0].name, quantity: line.quantity, unitPrice: line.unitPrice });
      }
      // The goods leave the shelf now, but only what is not reserved for app orders.
      const shelfItems = items.filter((i) => !i.surplusLotId);
      await deductWalkIn(c, req.center.centerId, shelfItems);
      await deductWalkInLots(c, req.center.centerId, items.filter((i) => i.surplusLotId));
      await checkLowStock(c, req.center.centerId, shelfItems.map((i) => i.productId));
      const created = {
        id: newOrderId(),
        customerName: str(input.customerName, 'customerName', { max: 80, optional: true }) || 'Walk-in customer',
        type: 'walkIn',
        status: 'completed',
        items,
        createdAt: new Date().toISOString(),
        pickupOtp: null,
        ownerId: null,
        centerId: req.center.centerId,
      };
      await insertOrder(c, created);
      return created;
    });
    res.status(201).json(view(order));
  }));

  router.get('/orders/:id', ah(async (req, res) => res.json(view(ownCenterOrder(req, await findOrder(db, req.params.id))))));

  router.post('/orders/:id/ready', ah(async (req, res) => {
    const order = await db.tx(async (c) => {
      const current = ownCenterOrder(req, await findOrder(c, req.params.id, { lock: true }));
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
      const current = ownCenterOrder(req, await findOrder(c, req.params.id, { lock: true }));
      if (current.status !== 'readyForPickup') throw new HttpError(409, 'This order is not ready for pickup yet');

      const expected = Buffer.from(current.pickupOtp || '');
      const given = Buffer.from(otp);
      const match = expected.length === given.length && crypto.timingSafeEqual(expected, given);
      if (!match) throw new HttpError(400, 'Incorrect OTP — please check with the farmer and try again.');

      await c.query("UPDATE orders SET status = 'completed', pickup_otp = NULL WHERE id = $1", [current.id]);
      await consumeOrderStock(c, current); // the goods leave the shelf
      // The first center a farmer actually collects from becomes their home center.
      if (current.ownerId && current.centerId) {
        await c.query(
          `INSERT INTO profiles (owner_id, home_center_id) VALUES ($1,$2)
           ON CONFLICT (owner_id) DO UPDATE SET home_center_id = COALESCE(profiles.home_center_id, EXCLUDED.home_center_id)`,
          [current.ownerId, current.centerId],
        );
      }
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
    ownCenterOrder(req, await findOrder(db, req.params.id)); // 404 unless it is this center's
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
    await sendPaged(req, res, db, {
      select: centers.INVENTORY_COLUMNS,
      from: `${centers.INVENTORY_FROM} WHERE ci.center_id = $1`,
      params: [req.center.centerId],
      order: 'p.seq',
    });
  }));

  // Stock arriving at the center. Adds to what is on hand.
  router.post('/inventory/receive', ah(async (req, res) => {
    const input = body(req);
    const item = await centers.receiveStock(db, {
      centerId: req.center.centerId,
      productId: str(input.productId, 'productId', { max: 100 }),
      quantity: num(input.quantity, 'quantity', { min: 1, max: 100000, integer: true }),
      expectedQuantity: input.expectedQuantity === undefined ? undefined : num(input.expectedQuantity, 'expectedQuantity', { min: 0, max: 100000, integer: true }),
      note: str(input.note, 'note', { max: 300, optional: true }),
    });
    // Best effort, after the stock is safely recorded: a failure here must not
    // undo or fail the receipt itself.
    notifyBackInStock(db, { centerId: req.center.centerId, productId: item.id }).catch((err) => console.error('Back-in-stock alerts failed:', err.message));
    res.status(201).json(item);
  }));

  // Reorder level and storage capacity for one product.
  router.patch('/inventory/items/:productId', ah(async (req, res) => {
    const input = body(req);
    const changes = {};
    if (input.reorderLevel !== undefined) changes.reorderLevel = num(input.reorderLevel, 'reorderLevel', { min: 0, max: 1000000, integer: true });
    if (input.maxCapacity !== undefined) {
      changes.maxCapacity = input.maxCapacity === null ? null : num(input.maxCapacity, 'maxCapacity', { min: 1, max: 1000000, integer: true });
    }
    res.json(await centers.updateInventorySettings(db, { centerId: req.center.centerId, productId: req.params.productId, ...changes }));
  }));

  router.get('/inventory/restock-requests', ah(async (req, res) => {
    await sendPaged(req, res, db, {
      select: RESTOCK_COLUMNS,
      from: 'restock_requests r JOIN products p ON p.id = r.product_id WHERE r.center_id = $1',
      params: [req.center.centerId],
      order: 'r.requested_date DESC, r.id',
    });
  }));

  router.post('/inventory/restock-requests', ah(async (req, res) => {
    const input = body(req);
    const productId = str(input.itemId ?? input.productId, 'itemId', { max: 100 });
    const quantity = num(input.quantity, 'quantity', { min: 1, max: 100000, integer: true });
    if (!(await db.query('SELECT 1 FROM products WHERE id = $1', [productId])).rows.length) throw new HttpError(404, 'Product not found');
    const id = `restock-${crypto.randomUUID()}`;
    await db.query(
      `INSERT INTO restock_requests (id, center_id, product_id, requested_quantity, status) VALUES ($1,$2,$3,$4,'pending')`,
      [id, req.center.centerId, productId, quantity],
    );
    res.status(201).json((await db.query(
      `SELECT ${RESTOCK_COLUMNS} FROM restock_requests r JOIN products p ON p.id = r.product_id WHERE r.id = $1`, [id])).rows[0]);
  }));

  // ---- Delivery partners ----
  // Farmers who asked THIS center to check their papers before they deliver.
  // Nobody else's applicants are visible here (they are a 404).
  router.get('/delivery-partners', ah(async (req, res) => {
    const params = [req.center.centerId];
    let where = "p.review_center_id = $1 AND p.status <> 'draft'";
    if (req.query.status) {
      params.push(oneOf(req.query.status, 'status', partners.STATUSES.filter((s) => s !== 'draft')));
      where += ` AND p.status = $${params.length}`;
    }
    if (req.query.q) {
      params.push(likePattern(req.query.q));
      where += ` AND (COALESCE(pr.name, '') || ' ' || COALESCE(p.vehicle_number, '') || ' ' || COALESCE(pr.village, '')) ILIKE $${params.length}`;
    }
    await sendPaged(req, res, db, {
      select: partners.PARTNER_COLUMNS,
      from: `${partners.PARTNER_FROM} WHERE ${where}`,
      params,
      // Waiting for review first, oldest application first, so nobody is left waiting.
      order: "(p.status = 'pending') DESC, p.submitted_at ASC NULLS LAST, p.user_id",
      finish: async (rows) => rows.map((r) => partners.toView(r)),
    });
  }));

  router.get('/delivery-partners/:userId', ah(async (req, res) => {
    res.json(await partners.detailFor(db, req.params.userId, { centerId: req.center.centerId }));
  }));

  // The licence or RC photo, for the operator who has to check it.
  router.get('/delivery-partners/:userId/documents/:kind', ah(async (req, res) => {
    await partners.detailFor(db, req.params.userId, { centerId: req.center.centerId }); // 404 unless theirs
    const doc = await partners.readDocument(db, req.params.userId, req.params.kind);
    res.set({ 'Content-Type': doc.contentType, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' }).send(doc.data);
  }));

  router.post('/delivery-partners/:userId/:action', ah(async (req, res) => {
    const action = oneOf(req.params.action, 'action', ['approve', 'reject', 'suspend', 'reactivate']);
    const note = str(body(req).note, 'note', { max: 300, optional: true }) || '';
    res.json(await partners.review(db, {
      userId: req.params.userId, action, note,
      actor: { id: deviceId(req), role: 'operator', centerId: req.center.centerId },
    }));
  }));

  // ---- Surplus / second-hand stock ----
  // Lots sold below the catalog price, kept apart from the regular shelf.
  const LOT_STATUSES = ['active', 'withdrawn'];

  router.get('/surplus', ah(async (req, res) => {
    const params = [req.center.centerId];
    let where = 'l.center_id = $1';
    // "active" here means still on the operator's list, i.e. not withdrawn;
    // sold-out and expired lots are shown so the operator can see what ended.
    if (req.query.status) {
      params.push(oneOf(req.query.status, 'status', LOT_STATUSES));
      where += ` AND l.status = $${params.length}`;
    }
    await sendPaged(req, res, db, {
      select: surplus.LOT_COLUMNS,
      from: `${surplus.LOT_FROM} WHERE ${where}`,
      params,
      order: 'l.created_at DESC, l.id',
      finish: async (rows) => rows.map(surplus.toMoney),
    });
  }));

  router.post('/surplus', ah(async (req, res) => {
    const input = body(req);
    const lot = await surplus.createLot(db, {
      centerId: req.center.centerId,
      productId: str(input.productId, 'productId', { max: 100 }),
      quantity: num(input.quantity, 'quantity', { min: 1, max: 100000, integer: true }),
      unitPrice: num(input.unitPrice, 'unitPrice', { min: 0, max: 10000000 }),
      condition: oneOf(input.condition, 'condition', surplus.CONDITIONS),
      bestBefore: input.bestBefore === undefined || input.bestBefore === null ? undefined : isoDate(input.bestBefore, 'bestBefore'),
      note: str(input.note, 'note', { max: 300, optional: true }),
      fromShelf: input.fromShelf === undefined ? false : bool(input.fromShelf, 'fromShelf'),
    });
    // Best effort, after the lot is safely recorded: a failure here must not fail the listing.
    notifyNewSurplus(db, { lotId: lot.id }).catch((err) => console.error('Surplus alerts failed:', err.message));
    res.status(201).json(lot);
  }));

  router.patch('/surplus/:id', ah(async (req, res) => {
    const input = body(req);
    res.json(await surplus.updateLot(db, {
      centerId: req.center.centerId,
      id: req.params.id,
      unitPrice: input.unitPrice === undefined ? undefined : num(input.unitPrice, 'unitPrice', { min: 0, max: 10000000 }),
      note: input.note === undefined ? undefined : str(input.note, 'note', { max: 300, optional: true }) || '',
    }));
  }));

  router.post('/surplus/:id/withdraw', ah(async (req, res) => {
    res.json(await surplus.withdrawLot(db, { centerId: req.center.centerId, id: req.params.id }));
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
       WHERE o.status = 'completed' AND o.center_id = $3`,
      [startOfDay, startOfMonth, req.center.centerId],
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
