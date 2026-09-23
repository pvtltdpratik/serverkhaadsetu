const { HttpError } = require('../utils/http');

// Locks suspended accounts out of the API. Runs after authentication, so
// `req.userId` is a verified Supabase user. Only GET /me stays open so the app
// can learn it is suspended and say so, instead of failing mysteriously.
//
// Administrators are never locked out. With authentication off (local
// development) identity is an anonymous device id, so there is nobody to
// suspend and this does nothing.
const createAccountGuard = (db, { authEnabled, isAdmin }) => async (req, res, next) => {
  try {
    if (!authEnabled || !req.userId || isAdmin(req)) return next();
    if (req.method === 'GET' && req.path === '/me') return next();
    const { rows } = await db.query('SELECT status FROM app_user WHERE user_id = $1', [req.userId]);
    if (rows.length && rows[0].status === 'suspended') {
      throw new HttpError(403, 'Your account has been suspended. Please contact the platform administrator.', { code: 'account_suspended' });
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = { createAccountGuard };
