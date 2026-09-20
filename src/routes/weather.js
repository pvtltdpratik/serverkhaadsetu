const express = require('express');
const { asyncHandler, num } = require('../utils/http');
const { fetchForecast } = require('../services/weather');

module.exports = () => {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const lat = num(req.query.lat, 'lat', { min: -90, max: 90 });
      const lon = num(req.query.lon, 'lon', { min: -180, max: 180 });
      res.json(await fetchForecast(lat, lon));
    }),
  );

  return router;
};
