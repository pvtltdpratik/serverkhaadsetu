const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const config = require('./config');
const { requireApiKey, generalLimiter } = require('./middleware/security');
const { notFound, errorHandler } = require('./middleware/errors');

const healthRouter = require('./routes/health');
const soilRouter = require('./routes/soil');
const weatherRouter = require('./routes/weather');
const farmerRouter = require('./routes/farmer');
const marketplaceRouter = require('./routes/marketplace');
const communityRouter = require('./routes/community');
const schemesRouter = require('./routes/schemes');
const operatorRouter = require('./routes/operator');

const createApp = (store) => {
  const app = express();

  // Behind Nginx on EC2: trust one proxy hop so rate limiting sees real client IPs.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan('combined'));
  app.use(express.json({ limit: '100kb' }));

  app.use('/health', healthRouter);

  const v1 = express.Router();
  v1.use(generalLimiter);
  v1.use(requireApiKey(config.apiKey));
  v1.use(soilRouter(store)); // POST /analyze, GET /history, GET /scan/:id
  v1.use('/weather', weatherRouter(store));
  v1.use('/farmer', farmerRouter(store));
  v1.use(marketplaceRouter(store)); // /products..., /orders...
  v1.use('/community', communityRouter(store));
  v1.use('/schemes', schemesRouter(store));
  v1.use('/operator', operatorRouter(store));
  app.use('/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
};

module.exports = { createApp };
