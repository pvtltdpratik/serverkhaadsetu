class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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

const body = (req) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return req.body;
};

const deviceId = (req) => {
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

module.exports = { HttpError, asyncHandler, str, num, oneOf, body, deviceId, sendList };
