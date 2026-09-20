const path = require('path');
require('dotenv').config();

module.exports = {
  port: Number(process.env.PORT) || 3000,
  // When set, every /v1 request must carry a matching X-API-Key header.
  apiKey: process.env.API_KEY || '',
  dataFile: process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'),
  commissionRatePercent: Number(process.env.COMMISSION_RATE_PERCENT) || 5,
  corsOrigin: process.env.CORS_ORIGIN || '*',
};
