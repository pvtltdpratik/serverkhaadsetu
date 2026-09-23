class HttpError extends Error {
  // `details` are extra fields merged into the JSON error body (e.g. the
  // alternatives offered when an item just went out of stock).
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const str = (value, name, { min = 1, max = 500, optional = false } = {}) => {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw new HttpError(400, `"${name}" is required`);
  }
  if (typeof value !== 'string') throw new HttpError(400, `"${name}" must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new HttpError(400, `"${name}" must be between ${min} and ${max} characters`);
  }
  return trimmed;
};

const num = (value, name, { min = -Infinity, max = Infinity, integer = false } = {}) => {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, `"${name}" must be a number`);
  }
  if (integer && !Number.isInteger(value)) throw new HttpError(400, `"${name}" must be an integer`);
  if (value < min || value > max) throw new HttpError(400, `"${name}" must be between ${min} and ${max}`);
  return value;
};

const oneOf = (value, name, allowed) => {
  if (!allowed.includes(value)) {
    throw new HttpError(400, `"${name}" must be one of: ${allowed.join(', ')}`);
  }
  return value;
};

const bool = (value, name) => {
  if (typeof value !== 'boolean') throw new HttpError(400, '"' + name + '" must be true or false');
  return value;
};

// A calendar date as YYYY-MM-DD (and a real one: 2026-02-30 is rejected).
const isoDate = (value, name) => {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  const ok = parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  if (!ok) throw new HttpError(400, '"' + name + '" must be a date like 2026-03-31');
  return value;
};

const body = (req) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return req.body;
};

// Who owns farmer-side data. With authentication on, it is the verified
// Supabase user id — the client-supplied device id is ignored so nobody can
// read or write another account's data by naming it. With authentication off
// (local development) it falls back to the anonymous device id.
const deviceId = (req) => {
  if (req.userId) return req.userId;
  const raw = req.get('x-device-id') || req.query.device_id;
  return str(raw, 'X-Device-Id header (or device_id query param)', { max: 100 });
};

const page = (req, items) => {
  const limit = req.query.limit === undefined ? 100 : num(req.query.limit, 'limit', { min: 1, max: 200, integer: true });
  const offset = req.query.offset === undefined ? 0 : num(req.query.offset, 'offset', { min: 0, integer: true });
  return { total: items.length, items: items.slice(offset, offset + limit) };
};

const sendList = (req, res, items) => {
  const { total, items: slice } = page(req, items);
  res.set('X-Total-Count', String(total));
  res.json(slice);
};

const paging = (req) => ({
  limit: req.query.limit === undefined ? 100 : num(req.query.limit, 'limit', { min: 1, max: 200, integer: true }),
  offset: req.query.offset === undefined ? 0 : num(req.query.offset, 'offset', { min: 0, integer: true }),
});

// Paginates in SQL. `from` is everything after FROM (joins + WHERE) and uses
// $1..$n for `params`; the total goes in X-Total-Count. `finish` (may be async)
// turns the page of rows into the response body.
const sendPaged = async (req, res, db, { select, from, params = [], order, finish = (rows) => rows }) => {
  const { limit, offset } = paging(req);
  const total = (await db.one(`SELECT count(*)::int AS n FROM ${from}`, params)).n;
  const rows = await db.rows(
    `SELECT ${select} FROM ${from} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  res.set('X-Total-Count', String(total));
  res.json(await finish(rows));
};

// Escapes LIKE wildcards so a search for "50%" matches the text, not everything.
const likePattern = (text) => `%${String(text).replace(/[\\%_]/g, '\\$&')}%`;

module.exports = { HttpError, asyncHandler, str, num, oneOf, bool, isoDate, body, deviceId, sendList, sendPaged, likePattern };
