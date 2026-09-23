const express = require('express');
const { HttpError, asyncHandler, str, num, oneOf, body, sendPaged, likePattern } = require('../utils/http');
const centers = require('../services/centerService');

const CENTER_STATUSES = ['active', 'suspended'];
const USER_ROLES = ['farmer', 'operator'];

const time = (value, name) => {
  if (typeof value !== 'string' || !centers.TIME.test(value)) throw new HttpError(400, `"${name}" must be a time like 09:30`);
  return value;
};

// Platform administration. Everything here is behind requireAdmin.
module.exports = (db, roles) => {
  const router = express.Router();
  const ah = asyncHandler;
  router.use(roles.requireAdmin);

  // ---- Village centers ----
  router.get('/centers', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      params.push(oneOf(req.query.status, 'status', CENTER_STATUSES));
      where.push(`c.status = $${params.length}`);
    }
    if (req.query.q) {
      params.push(likePattern(req.query.q));
      where.push(`(c.name || ' ' || c.village || ' ' || c.district) ILIKE $${params.length}`);
    }
    await sendPaged(req, res, db, {
      select: centers.CENTER_COLUMNS,
      from: `village_center c${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'c.created_at DESC, c.center_id',
    });
  }));

  router.post('/centers', ah(async (req, res) => {
    const input = body(req);
    const center = await centers.createCenter(db, {
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
    res.status(201).json(center);
  }));

  router.get('/centers/:id', ah(async (req, res) => res.json(await centers.findCenter(db, req.params.id))));

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
    res.json(await centers.updateCenter(db, req.params.id, changes));
  }));

  // `{ "userId": "..." }` assigns; `{ "userId": null }` unassigns.
  router.put('/centers/:id/operator', ah(async (req, res) => {
    const input = body(req);
    const userId = input.userId === null ? null : str(input.userId, 'userId', { max: 100 });
    res.json(await centers.assignOperator(db, req.params.id, userId));
  }));

  // ---- Users (everyone who has signed in) ----
  router.get('/users', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.requestedRole) {
      params.push(oneOf(req.query.requestedRole, 'requestedRole', USER_ROLES));
      where.push(`u.requested_role = $${params.length}`);
    }
    if (req.query.q) {
      params.push(likePattern(req.query.q));
      where.push(`(u.name || ' ' || u.email) ILIKE $${params.length}`);
    }
    if (req.query.unassigned === 'true') where.push('c.center_id IS NULL');
    await sendPaged(req, res, db, {
      select: `u.user_id AS "userId", u.email, u.name, u.requested_role AS "requestedRole", u.status,
        u.created_at AS "createdAt", u.last_seen_at AS "lastSeenAt", c.center_id AS "centerId", c.name AS "centerName"`,
      from: `app_user u LEFT JOIN village_center c ON c.operator_id = u.user_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
      order: 'u.created_at DESC, u.user_id',
    });
  }));

  return router;
};
