const express = require('express');
const { HttpError, asyncHandler, str, num, oneOf, body, sendPaged, likePattern, deviceId } = require('../utils/http');
const centers = require('../services/centerService');
const admin = require('../services/adminService');
const { recordAudit } = require('../services/audit');
const { withItems, serializeOrder } = require('../services/orders');
const { notify } = require('../services/notifications');
const surplus = require('../services/surplus');
const { adminResale } = require('./resaleStaff');
const partners = require('../services/deliveryPartner');
const flow = require('../services/deliveryFlow');

const CENTER_STATUSES = ['active', 'suspended'];
const ACCOUNT_STATUSES = ['active', 'suspended'];
const ORDER_STATUSES = ['pending', 'readyForPickup', 'completed', 'cancelled'];
const ORDER_TYPES = ['appOrder', 'walkIn'];
const RESTOCK_STATUSES = ['pending', 'approved', 'fulfilled'];

const time = (value, name) => {
  if (typeof value !== 'string' || !centers.TIME.test(value)) throw new HttpError(400, `"${name}" must be a time like 09:30`);
  return value;
};

// What the admin panel shows for a center: the center, its operator, and how
// its shelves and queue look right now.
const CENTER_ROWS = `${centers.CENTER_COLUMNS},
  u.email AS "operatorEmail", u.name AS "operatorUserName", u.status AS "operatorStatus",
  (SELECT count(*)::int FROM center_inventory ci WHERE ci.center_id = c.center_id AND ci.on_hand > 0) AS "productsStocked",
  (SELECT count(*)::int FROM center_inventory ci WHERE ci.center_id = c.center_id AND ci.on_hand > 0 AND ci.on_hand - ci.reserved <= ci.reorder_level) AS "lowStockCount",
  (SELECT count(*)::int FROM orders o WHERE o.center_id = c.center_id AND o.status IN ('pending','readyForPickup')) AS "pendingOrders"`;
const CENTER_FROM = 'village_center c LEFT JOIN app_user u ON u.user_id = c.operator_id';

// Platform administration. Everything here is behind requireAdmin, and every
// change is recorded in the audit log in the same transaction.
module.exports = (db, roles) => {
  const router = express.Router();
  const ah = asyncHandler;
  router.use(roles.requireAdmin);
  router.use('/resale', adminResale(db)); // complaints about surplus goods, UPI payouts to sellers

  // ---- Overview ----
  router.get('/overview', ah(async (req, res) => res.json(await admin.overview(db, roles.adminEmails))));

  // ---- Village centers ----
  router.get('/centers', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      params.push(oneOf(req.query.status, 'status', CENTER_STATUSES));
      where.push(`c.status = $${params.length}`);
    }
    if (req.query.district) {
      params.push(String(req.query.district));
      where.push(`lower(c.district) = lower($${params.length})`);
    }
    if (req.query.hasOperator !== undefined) where.push(String(req.query.hasOperator) === 'true' ? 'c.operator_id IS NOT NULL' : 'c.operator_id IS NULL');
    if (req.query.q) {
      params.push(likePattern(req.query.q));
      where.push(`(c.name || ' ' || c.village || ' ' || c.district) ILIKE $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: CENTER_ROWS,
      from: `${CENTER_FROM}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'c.created_at DESC, c.center_id',
    });
  }));

  router.post('/centers', ah(async (req, res) => {
    const input = body(req);
    const created = await db.tx(async (c) => {
      const center = await centers.createCenter(c, {
        name: str(input.name, 'name', { max: 120 }),
        village: str(input.village, 'village', { max: 120 }),
        district: str(input.district, 'district', { max: 80, optional: true }) || '',
        latitude: num(input.latitude, 'latitude', { min: -90, max: 90 }),
        longitude: num(input.longitude, 'longitude', { min: -180, max: 180 }),
        phone: str(input.phone, 'phone', { max: 30, optional: true }) || '',
        operatorName: str(input.operatorName, 'operatorName', { max: 120, optional: true }) || '',
        operatorId: str(input.operatorId, 'operatorId', { max: 100, optional: true }),
        opensAt: input.opensAt === undefined ? '09:00' : time(input.opensAt, 'opensAt'),
        closesAt: input.closesAt === undefined ? '18:00' : time(input.closesAt, 'closesAt'),
      });
      await recordAudit(c, req, { action: 'center.create', targetType: 'center', targetId: center.centerId, details: { name: center.name, operatorId: center.operatorId } });
      return center;
    });
    res.status(201).json(created);
  }));

  router.get('/centers/:id', ah(async (req, res) => {
    const { rows } = await db.query(`SELECT ${CENTER_ROWS} FROM ${CENTER_FROM} WHERE c.center_id = $1`, [req.params.id]);
    if (!rows.length) throw new HttpError(404, 'Village center not found');
    res.json(rows[0]);
  }));

  router.patch('/centers/:id', ah(async (req, res) => {
    const input = body(req);
    const changes = {};
    if (input.name !== undefined) changes.name = str(input.name, 'name', { max: 120 });
    if (input.village !== undefined) changes.village = str(input.village, 'village', { max: 120 });
    if (input.district !== undefined) changes.district = str(input.district, 'district', { max: 80, optional: true }) || '';
    if (input.latitude !== undefined) changes.latitude = num(input.latitude, 'latitude', { min: -90, max: 90 });
    if (input.longitude !== undefined) changes.longitude = num(input.longitude, 'longitude', { min: -180, max: 180 });
    if (input.phone !== undefined) changes.phone = str(input.phone, 'phone', { max: 30, optional: true }) || '';
    if (input.operatorName !== undefined) changes.operatorName = str(input.operatorName, 'operatorName', { max: 120, optional: true }) || '';
    if (input.opensAt !== undefined) changes.opensAt = time(input.opensAt, 'opensAt');
    if (input.closesAt !== undefined) changes.closesAt = time(input.closesAt, 'closesAt');
    if (input.status !== undefined) changes.status = oneOf(input.status, 'status', CENTER_STATUSES);
    const updated = await db.tx(async (c) => {
      const center = await centers.updateCenter(c, req.params.id, changes);
      await recordAudit(c, req, { action: changes.status ? `center.${changes.status === 'suspended' ? 'suspend' : 'reactivate'}` : 'center.update', targetType: 'center', targetId: center.centerId, details: changes });
      return center;
    });
    res.json(updated);
  }));

  // `{ "userId": "..." }` assigns; `{ "userId": null }` unassigns.
  router.put('/centers/:id/operator', ah(async (req, res) => {
    const input = body(req);
    const userId = input.userId === null ? null : str(input.userId, 'userId', { max: 100 });
    const updated = await db.tx(async (c) => {
      const center = await centers.assignOperator(c, req.params.id, userId);
      await recordAudit(c, req, { action: userId ? 'center.assignOperator' : 'center.unassignOperator', targetType: 'center', targetId: center.centerId, details: { operatorId: userId } });
      return center;
    });
    res.json(updated);
  }));

  // What is on a center's shelves.
  router.get('/centers/:id/inventory', ah(async (req, res) => {
    await centers.findCenter(db, req.params.id);
    await sendPaged(req, res, db, {
      select: centers.INVENTORY_COLUMNS,
      from: `${centers.INVENTORY_FROM} WHERE ci.center_id = $1`,
      params: [req.params.id],
      order: 'p.seq',
    });
  }));

  // ---- People ----
  router.get('/users/summary', ah(async (req, res) => res.json(await admin.userSummary(db, roles.adminEmails))));

  router.get('/users', ah(async (req, res) => {
    const where = [];
    const params = [roles.adminEmails];
    if (req.query.role) {
      params.push(oneOf(req.query.role, 'role', admin.ROLES));
      where.push(`t.role = $${params.length}`);
    }
    if (req.query.segment) {
      params.push(oneOf(req.query.segment, 'segment', admin.SEGMENTS));
      where.push(`t.segment = $${params.length}`);
    }
    if (req.query.q) {
      params.push(likePattern(req.query.q));
      where.push(`(t.name || ' ' || t.email || ' ' || COALESCE(t.village, '')) ILIKE $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: 't.*',
      from: `(${admin.USER_ROWS}) t${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 't."createdAt" DESC, t."userId"',
    });
  }));

  router.get('/users/:id', ah(async (req, res) => res.json(await admin.userDetail(db, req.params.id, roles.adminEmails))));

  // Suspend or reactivate. A suspended person is locked out of the API at once.
  router.patch('/users/:id', ah(async (req, res) => {
    const input = body(req);
    const status = oneOf(input.status, 'status', ACCOUNT_STATUSES);
    const reason = str(input.reason, 'reason', { max: 300, optional: true });
    if (req.params.id === deviceId(req)) throw new HttpError(400, 'You cannot change your own account');
    const target = await admin.findUserRow(db, req.params.id, roles.adminEmails);
    await db.tx(async (c) => {
      await c.query('UPDATE app_user SET status = $2 WHERE user_id = $1', [req.params.id, status]);
      await notify(c, req.params.id, {
        type: 'account',
        title: status === 'suspended' ? 'Your account was suspended' : 'Your account was reactivated',
        body: status === 'suspended' ? `Contact the platform administrator.${reason ? ` Reason: ${reason}` : ''}` : 'You can use the app again.',
      });
      await recordAudit(c, req, {
        action: status === 'suspended' ? 'user.suspend' : 'user.reactivate', targetType: 'user', targetId: req.params.id,
        details: { role: target.role, ...(reason ? { reason } : {}) },
      });
    });
    res.json(await admin.userDetail(db, req.params.id, roles.adminEmails));
  }));

  // ---- Orders across every center ----
  router.get('/orders', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      params.push(oneOf(req.query.status, 'status', ORDER_STATUSES));
      where.push(`o.status = $${params.length}`);
    }
    if (req.query.type) {
      params.push(oneOf(req.query.type, 'type', ORDER_TYPES));
      where.push(`o.type = $${params.length}`);
    }
    if (req.query.centerId) {
      params.push(String(req.query.centerId));
      where.push(`o.center_id = $${params.length}`);
    }
    if (req.query.q) {
      params.push(likePattern(req.query.q));
      where.push(`o.customer_name ILIKE $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: `o.id, o.customer_name AS "customerName", o.type, o.status, o.created_at AS "createdAt", o.pickup_otp AS "pickupOtp",
               o.owner_id AS "ownerId", o.center_id AS "centerId", o.stock_reserved AS "stockReserved", o.reserved_until AS "reservedUntil",
               c.name AS "centerName"`,
      from: `orders o LEFT JOIN village_center c ON c.center_id = o.center_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'o.created_at DESC, o.id',
      finish: async (rows) => (await withItems(db, rows)).map((o) => serializeOrder(o, { includeOtp: false })),
    });
  }));

  // ---- Restock requests (supply chain) ----
  router.get('/restock-requests', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      params.push(oneOf(req.query.status, 'status', RESTOCK_STATUSES));
      where.push(`r.status = $${params.length}`);
    }
    if (req.query.centerId) {
      params.push(String(req.query.centerId));
      where.push(`r.center_id = $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: `r.id, r.center_id AS "centerId", c.name AS "centerName", r.product_id AS "productId", p.name AS "productName",
               r.requested_quantity AS "requestedQuantity", r.status, r.requested_date AS "requestedDate"`,
      from: `restock_requests r JOIN village_center c ON c.center_id = r.center_id JOIN products p ON p.id = r.product_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'r.requested_date DESC, r.id',
    });
  }));

  router.patch('/restock-requests/:id', ah(async (req, res) => {
    const to = oneOf(body(req).status, 'status', ['approved', 'fulfilled']);
    // advanceRestock runs its own transaction; the notification and audit entry
    // are written inside it, so they commit or roll back with the status change.
    const request = await admin.advanceRestock(db, req.params.id, to, async (tx, r) => {
      const operator = (await tx.query('SELECT operator_id FROM village_center WHERE center_id = $1', [r.center_id])).rows[0];
      if (operator) {
        await notify(tx, operator.operator_id, {
          type: 'restock',
          title: to === 'approved' ? 'Restock approved' : 'Restock delivered',
          body: to === 'approved' ? 'Your restock request was approved and is on its way.' : 'Your restock has been delivered. Confirm the stock when you receive it.',
          refId: r.id,
        });
      }
      await recordAudit(tx, req, { action: `restock.${to}`, targetType: 'restock', targetId: r.id, details: { centerId: r.center_id, productId: r.product_id, quantity: r.requested_quantity } });
    });
    res.json({ id: request.id, status: to });
  }));

  // ---- Stock discrepancies (delivery did not match what was expected) ----
  router.get('/discrepancies', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      params.push(oneOf(req.query.status, 'status', ['open', 'resolved']));
      where.push(`d.status = $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: `d.id, d.center_id AS "centerId", c.name AS "centerName", d.product_id AS "productId", p.name AS "productName",
               d.expected_quantity AS "expectedQuantity", d.received_quantity AS "receivedQuantity", d.note, d.status,
               d.resolution_note AS "resolutionNote", d.created_at AS "createdAt", d.resolved_at AS "resolvedAt"`,
      from: `stock_discrepancy d JOIN village_center c ON c.center_id = d.center_id JOIN products p ON p.id = d.product_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'd.created_at DESC, d.id',
    });
  }));

  router.patch('/discrepancies/:id', ah(async (req, res) => {
    const input = body(req);
    const note = str(input.note, 'note', { max: 300, optional: true }) || '';
    await db.tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE stock_discrepancy SET status = 'resolved', resolution_note = $2, resolved_at = now()
          WHERE id = $1 AND status = 'open' RETURNING center_id, product_id`, [req.params.id, note]);
      if (!rows.length) {
        const exists = (await c.query('SELECT status FROM stock_discrepancy WHERE id = $1', [req.params.id])).rows[0];
        throw new HttpError(exists ? 409 : 404, exists ? 'That discrepancy is already resolved' : 'Discrepancy not found');
      }
      const operator = (await c.query('SELECT operator_id FROM village_center WHERE center_id = $1', [rows[0].center_id])).rows[0];
      if (operator) {
        await notify(c, operator.operator_id, {
          type: 'stock', title: 'Delivery discrepancy reviewed',
          body: note ? `The supply team reviewed your report: ${note}` : 'The supply team has reviewed your delivery report.',
          refId: req.params.id,
        });
      }
      await recordAudit(c, req, { action: 'discrepancy.resolve', targetType: 'discrepancy', targetId: req.params.id, details: { centerId: rows[0].center_id, productId: rows[0].product_id, note } });
    });
    res.json({ id: req.params.id, status: 'resolved' });
  }));

  // ---- Deliveries ----
  router.get('/deliveries', ah(async (req, res) => {
    const params = [];
    const where = [];
    if (req.query.status) {
      params.push(oneOf(req.query.status, 'status', ['open', 'assigned', 'in_transit', 'delivered', 'cancelled', 'fallback']));
      where.push(`j.status = $${params.length}`);
    }
    if (req.query.centerId) {
      params.push(String(req.query.centerId));
      where.push(`j.center_id = $${params.length}`);
    }
    if (req.query.kind) {
      params.push(oneOf(req.query.kind, 'kind', ['center_order', 'p2p']));
      where.push(`j.kind = $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: `${flow.OPERATOR_SELECT}, j.center_id AS "centerId", cn.name AS "centerName"`,
      from: `${flow.OPERATOR_FROM} LEFT JOIN village_center cn ON cn.center_id = j.center_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: "CASE j.status WHEN 'open' THEN 0 WHEN 'assigned' THEN 1 WHEN 'in_transit' THEN 2 ELSE 3 END, j.created_at DESC, j.id",
      finish: async (rows) => rows.map(flow.operatorShape),
    });
  }));

  // ---- Delivery partners ----
  // Every farmer who applied to deliver, whichever center is checking them.
  router.get('/delivery-partners', ah(async (req, res) => {
    const params = [];
    const where = ["p.status <> 'draft'"];
    if (req.query.status) {
      params.push(oneOf(req.query.status, 'status', partners.STATUSES.filter((s) => s !== 'draft')));
      where.push(`p.status = $${params.length}`);
    }
    if (req.query.centerId) {
      params.push(String(req.query.centerId));
      where.push(`p.review_center_id = $${params.length}`);
    }
    if (req.query.q) {
      params.push(likePattern(req.query.q));
      where.push(`(COALESCE(pr.name, '') || ' ' || COALESCE(p.vehicle_number, '') || ' ' || COALESCE(pr.village, '')) ILIKE $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: partners.PARTNER_COLUMNS,
      from: `${partners.PARTNER_FROM} WHERE ${where.join(' AND ')}`,
      params,
      order: "(p.status = 'pending') DESC, p.submitted_at ASC NULLS LAST, p.user_id",
      finish: async (rows) => rows.map((r) => partners.toView(r)),
    });
  }));

  router.get('/delivery-partners/:userId', ah(async (req, res) => res.json(await partners.detailFor(db, req.params.userId))));

  router.get('/delivery-partners/:userId/documents/:kind', ah(async (req, res) => {
    const doc = await partners.readDocument(db, req.params.userId, req.params.kind);
    res.set({ 'Content-Type': doc.contentType, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' }).send(doc.data);
  }));

  // Approve, reject, suspend or reactivate; the platform can do what a center's operator can, for anyone.
  router.post('/delivery-partners/:userId/:action', ah(async (req, res) => {
    const action = oneOf(req.params.action, 'action', ['approve', 'reject', 'suspend', 'reactivate']);
    const note = str(body(req).note, 'note', { max: 300, optional: true }) || '';
    res.json(await partners.review(db, {
      userId: req.params.userId, action, note,
      actor: { id: deviceId(req), role: 'admin' },
      after: (tx) => recordAudit(tx, req, { action: `delivery_partner.${action}`, targetType: 'delivery_partner', targetId: req.params.userId, details: { note } }),
    }));
  }));

  // ---- Surplus / second-hand stock ----
  // Every center's lots, so the platform can see what is being sold cheaply and
  // step in (for example a lot that is past its date or wrongly described).
  router.get('/surplus', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      params.push(oneOf(req.query.status, 'status', ['active', 'withdrawn']));
      where.push(`l.status = $${params.length}`);
    }
    if (req.query.centerId) {
      params.push(String(req.query.centerId));
      where.push(`l.center_id = $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: `${surplus.LOT_COLUMNS}, c.name AS "centerName", c.village`,
      from: `${surplus.LOT_FROM} JOIN village_center c ON c.center_id = l.center_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'l.created_at DESC, l.id',
      finish: async (rows) => rows.map(surplus.toMoney),
    });
  }));

  // Takes a lot off sale, with an optional reason the operator is told.
  router.post('/surplus/:id/withdraw', ah(async (req, res) => {
    const reason = str(body(req).reason, 'reason', { max: 300, optional: true }) || '';
    const lot = (await db.query('SELECT center_id FROM surplus_lot WHERE id = $1', [req.params.id])).rows[0];
    if (!lot) throw new HttpError(404, 'Surplus lot not found');
    const result = await surplus.withdrawLot(db, {
      centerId: lot.center_id,
      id: req.params.id,
      after: async (tx, l) => {
        const operator = (await tx.query('SELECT operator_id FROM village_center WHERE center_id = $1', [l.centerId])).rows[0];
        if (operator) {
          await notify(tx, operator.operator_id, {
            type: 'stock',
            title: 'A surplus offer was withdrawn',
            body: reason ? `The platform took one of your surplus offers off sale: ${reason}` : 'The platform took one of your surplus offers off sale.',
            refId: l.id,
          });
        }
        await recordAudit(tx, req, { action: 'surplus.withdraw', targetType: 'surplus', targetId: l.id, details: { centerId: l.centerId, productId: l.productId, reason } });
      },
    });
    res.json(result);
  }));

  // ---- Audit log ----
  router.get('/audit', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.targetType) {
      params.push(String(req.query.targetType));
      where.push(`target_type = $${params.length}`);
    }
    if (req.query.targetId) {
      params.push(String(req.query.targetId));
      where.push(`target_id = $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: `id, admin_id AS "adminId", admin_email AS "adminEmail", action, target_type AS "targetType", target_id AS "targetId", details, created_at AS "createdAt"`,
      from: `admin_audit${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'created_at DESC, id',
    });
  }));

  return router;
};
