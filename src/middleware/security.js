const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const { HttpError } = require('../utils/http');

const requireApiKey = (expected) => (req, res, next) => {
  if (!expected) return next();
  const provided = Buffer.from(req.get('x-api-key') || '');
  const wanted = Buffer.from(expected);
  const ok = provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
  return ok ? next() : next(new HttpError(401, 'Missing or invalid API key'));
};

const limiter = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res, next) => next(new HttpError(429, message)),
  });

// Requests per minute per client IP. Raise it if many people share one address (a
// village Wi-Fi, a proxy) or in load tests; the default suits normal use.
const generalLimiter = limiter(60 * 1000, Number(process.env.RATE_LIMIT_PER_MINUTE) || 300, 'Too many requests — please slow down');
// Pickup OTPs are only 4 digits, so guessing has to be throttled hard.
const otpLimiter = limiter(15 * 60 * 1000, Number(process.env.RATE_LIMIT_OTP) || 10, 'Too many OTP attempts — please wait a few minutes');
const analyzeLimiter = limiter(60 * 1000, 20, 'Too many scans — please wait a moment');

// Each question costs money, so one farmer gets a limited number an hour (by account, not address).
const assistantLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.ASSISTANT_PER_HOUR) || 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `assistant:${req.userId || req.get('x-device-id') || 'anonymous'}`,
  validate: { keyGeneratorIpFallback: false },
  handler: (req, res, next) => next(new HttpError(429, 'You have asked a lot of questions. Please try again in a while.')),
});

module.exports = { requireApiKey, generalLimiter, otpLimiter, analyzeLimiter, assistantLimiter };
