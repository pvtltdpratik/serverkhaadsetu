const { createRemoteJWKSet, jwtVerify } = require('jose');
const { HttpError } = require('../utils/http');

// Verifies Supabase Auth access tokens (`Authorization: Bearer <jwt>`).
//
// Supabase signs user tokens with an asymmetric key and publishes the public
// half at <project>/auth/v1/.well-known/jwks.json, so verification is a local
// signature check — the server never calls Supabase per request, and holds no
// secret. On success `req.userId` is the Supabase user's id (the JWT `sub`).
//
// When no Supabase URL is configured, authentication is off and the API falls
// back to the old anonymous `X-Device-Id` scoping (local development / tests).
const createAuth = ({ supabaseUrl, jwks } = {}) => {
  if (!supabaseUrl) return { enabled: false, middleware: (req, res, next) => next() };

  const base = supabaseUrl.replace(/\/+$/, '');
  const issuer = `${base}/auth/v1`;
  const keys = jwks || createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

  const middleware = async (req, res, next) => {
    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return next(new HttpError(401, 'Please sign in to continue'));
    try {
      const { payload } = await jwtVerify(match[1], keys, { issuer, audience: 'authenticated' });
      if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('token has no subject');
      req.userId = payload.sub;
      return next();
    } catch (err) {
      // Expired tokens are routine (the app refreshes and retries); anything
      // else is a bad or forged token. Either way the client just re-signs-in.
      const expired = err && err.code === 'ERR_JWT_EXPIRED';
      return next(new HttpError(401, expired ? 'Your session has expired. Please sign in again.' : 'Invalid sign-in token'));
    }
  };

  return { enabled: true, middleware };
};

module.exports = { createAuth };
