const express = require('express');
const { asyncHandler, deviceId } = require('../utils/http');
const { upsertUser } = require('../services/centerService');

// Who am I? Called by the app after sign-in: records the account (so admins
// can see and manage it) and reports the caller's real, server-decided role.
module.exports = (db, roles) => {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const userId = deviceId(req);
    const meta = req.userMetadata || {};
    const user = await upsertUser(db, {
      userId,
      email: req.userEmail || '',
      name: typeof meta.full_name === 'string' ? meta.full_name.slice(0, 120) : '',
      requestedRole: meta.role === 'operator' ? 'operator' : 'farmer',
    });
    const center = (await db.query(
      `SELECT center_id AS "centerId", name, status FROM village_center WHERE operator_id = $1`, [userId],
    )).rows[0] || null;

    // Admin wins; then operator (owns a center); everyone else is a farmer.
    // An operator with no center yet is a farmer here, with `requestedRole`
    // telling the app to show "waiting for a center to be assigned".
    const role = roles.isAdmin(req) ? 'admin' : center ? 'operator' : 'farmer';
    res.json({ ...user, role, center });
  }));

  return router;
};
