const config = require('../config');
const { HttpError } = require('../utils/http');

const NUMERIC_FIELDS = [
  'health_score', 'soil_moisture', 'nutrient_n', 'nutrient_p', 'nutrient_k', 'disease_confidence',
];

// Upstream statuses that describe a problem with the request itself and are
// safe to relay. Anything else (401/404/5xx...) means the analyzer is down or
// misconfigured, which is our problem, not the client's -> 502.
const RELAYED = new Set([400, 413, 422]);

const upstreamMessage = (status, payload) => {
  const detail = payload && payload.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail[0] && detail[0].msg) {
    return `Soil analyzer rejected the request: ${detail[0].msg}`;
  }
  return `Soil analyzer rejected the request (${status})`;
};

// The analyzer sends naive UTC timestamps ("2026-09-20T16:04:24.676865", no
// zone). Clients would read that as local time and show every scan hours off,
// so it is turned into an explicit UTC ISO string here. Returns null if the
// value isn't a parseable date.
const toUtcIso = (raw) => {
  if (typeof raw !== 'string') return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const date = new Date(hasZone ? raw : `${raw}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const isValidResult = (r) =>
  r &&
  typeof r.id === 'string' &&
  typeof r.disease === 'string' &&
  toUtcIso(r.created_at) !== null &&
  Array.isArray(r.recommendations) &&
  NUMERIC_FIELDS.every((k) => typeof r[k] === 'number');

// The analyzer validates the upload by its part Content-Type and rejects
// application/octet-stream — which is what Flutter's MultipartFile.fromBytes
// sends by default. So the type is decided here from the file's magic bytes,
// with the client's declared type only as a fallback.
const sniffImageType = (buf) => {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.toString('latin1', 0, 6))) return 'image/gif';
  return null;
};

const uploadType = (buffer, declared) => {
  const sniffed = sniffImageType(buffer);
  if (sniffed) return sniffed;
  return declared && declared.startsWith('image/') ? declared : 'application/octet-stream';
};

// Forwards the photo (and optional crop type) to the external Soil Sense
// service at SOIL_ANALYZER_URL and returns its AnalysisResponse.
async function analyzeImage({ buffer, filename, mimetype, deviceId, cropType }) {
  const url = config.soilAnalyzerUrl;
  if (!url) throw new HttpError(503, 'Soil analysis is not configured on the server');

  const form = new FormData();
  form.append('image', new Blob([buffer], { type: uploadType(buffer, mimetype) }), filename || 'scan.jpg');
  form.append('metadata_json', JSON.stringify({ device_id: deviceId, ...(cropType ? { crop_type: cropType } : {}) }));

  let response;
  try {
    response = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(config.soilAnalyzerTimeoutMs) });
  } catch (err) {
    console.error(`Soil analyzer request to ${url} failed:`, err.message);
    if (err.name === 'TimeoutError') throw new HttpError(504, 'The soil analysis service took too long to respond. Please try again.');
    throw new HttpError(502, "Couldn't reach the soil analysis service. Please try again later.");
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // non-JSON body; handled below
  }

  if (!response.ok) {
    console.error(`Soil analyzer returned ${response.status}: ${text.slice(0, 300)}`);
    if (RELAYED.has(response.status)) throw new HttpError(response.status, upstreamMessage(response.status, payload));
    throw new HttpError(502, 'The soil analysis service returned an error. Please try again later.');
  }
  if (!isValidResult(payload)) {
    console.error(`Soil analyzer returned an unexpected body: ${text.slice(0, 300)}`);
    throw new HttpError(502, 'The soil analysis service returned an unexpected response.');
  }
  return { ...payload, created_at: toUtcIso(payload.created_at) };
}

module.exports = { analyzeImage };
