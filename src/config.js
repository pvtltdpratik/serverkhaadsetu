const path = require('path');
require('dotenv').config();

module.exports = {
  port: Number(process.env.PORT) || 3000,
  // When set, every /v1 request must carry a matching X-API-Key header.
  apiKey: process.env.API_KEY || '',
  dataFile: process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'),
  // Full URL of the Soil Sense analyze endpoint. Set it to an empty value to
  // disable scanning (the API then answers 503).
  soilAnalyzerUrl: process.env.SOIL_ANALYZER_URL ?? 'http://localhost:8000/v1/analyze',
  soilAnalyzerTimeoutMs: Number(process.env.SOIL_ANALYZER_TIMEOUT_MS) || 25000,
  commissionRatePercent: Number(process.env.COMMISSION_RATE_PERCENT) || 5,
  corsOrigin: process.env.CORS_ORIGIN || '*',
};
