const { HttpError, deviceId } = require('../utils/http');

// Server-side authorisation. The role a user picked at sign-up lives in their
// (user-editable) Supabase metadata, so it is never trusted here:
//   admin    = the verified token's email is in SUPER_ADMIN_EMAILS
//   operator = the user owns a village_center (set by an admin)
//   farmer   = everyone else
//
// With authentication off (local development, where identity is just an
// anonymous device id) admin checks are skipped; the operator check still
// applies, keyed on the device id.
const createRoles = (db, { authEnabled, superAdminEmails }) => {
  const admins = new Set(superAdminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));

  // Strict: is this verified account a listed administrator?
  const isAdmin = (req) => Boolean(req.userEmail) && admins.has(req.userEmail);

  const requireAdmin = (req, res, next) =>
    next(!authEnabled || isAdmin(req) ? undefined : new HttpError(403, 'This area is for administrators only'));

  // Loads the caller's own center into `req.center`.
  const requireOperator = async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT center_id AS "centerId", status FROM village_center WHERE operator_id = $1`,
        [deviceId(req)],
      );
      if (!rows.length) throw new HttpError(403, 'No village center is assigned to your account yet');
      if (rows[0].status !== 'active') throw new HttpError(403, 'Your village center is suspended. Contact the platform admin.');
      req.center = rows[0];
      next();
    } catch (err) {
      next(err);
    }
  };

  return { isAdmin, requireAdmin, requireOperator };
};

module.exports = { createRoles };
