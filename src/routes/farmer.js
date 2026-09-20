const express = require('express');
const { str, num, body, deviceId } = require('../utils/http');

const RETENTION_MS = 15 * 24 * 3600 * 1000;
const NUTRIENTS = [
  ['nutrient_n', 'Nitrogen', 'vermicompost or neem cake'],
  ['nutrient_p', 'Phosphorus', 'bone meal or rock phosphate mixed with compost'],
  ['nutrient_k', 'Potassium', 'wood ash or well-rotted compost'],
];

const defaultProfile = () => ({ name: 'Farmer', village: '', unreadNotificationCount: 0, landHoldingHectares: 0 });

module.exports = (store) => {
  const router = express.Router();

  const profileFor = (device) => store.data.profiles.find((p) => p.deviceId === device);
  const publicProfile = (p) => ({
    name: p.name,
    village: p.village,
    unreadNotificationCount: p.unreadNotificationCount,
    landHoldingHectares: p.landHoldingHectares,
  });

  router.get('/profile', (req, res) => {
    const p = profileFor(deviceId(req));
    res.json(publicProfile(p || defaultProfile()));
  });

  router.put('/profile', (req, res) => {
    const device = deviceId(req);
    const input = body(req);
    const existing = profileFor(device) || { deviceId: device, ...defaultProfile() };
    if (input.name !== undefined) existing.name = str(input.name, 'name', { max: 80 });
    if (input.village !== undefined) existing.village = str(input.village, 'village', { max: 120 });
    if (input.landHoldingHectares !== undefined) {
      existing.landHoldingHectares = num(input.landHoldingHectares, 'landHoldingHectares', { min: 0, max: 10000 });
    }
    if (input.unreadNotificationCount !== undefined) {
      existing.unreadNotificationCount = num(input.unreadNotificationCount, 'unreadNotificationCount', { min: 0, max: 100000, integer: true });
    }
    if (!profileFor(device)) store.data.profiles.push(existing);
    store.save();
    res.json(publicProfile(existing));
  });

  // The single "smart recommendation" card on the home screen, derived from
  // the device's latest scan: dry soil > likely disease > lowest nutrient >
  // healthy/harvest, with a "scan your soil" nudge when there is no scan yet.
  router.get('/recommendation', (req, res) => {
    const device = deviceId(req);
    const cutoff = Date.now() - RETENTION_MS;
    const latest = store.data.scans
      .filter((s) => s.metadata.device_id === device && new Date(s.created_at).getTime() >= cutoff)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

    if (!latest) {
      return res.json({
        category: 'nutrient',
        title: 'Scan your soil to get started',
        description: 'A quick photo scan gives you a soil health score and tailored advice for your crop.',
        actionLabel: 'Scan soil',
      });
    }
    const crop = latest.metadata.crop_type ? ` ${latest.metadata.crop_type}` : '';
    if (latest.soil_moisture < 30) {
      return res.json({
        category: 'water',
        title: 'Your soil is running dry',
        description: `Your last scan shows low soil moisture. A light irrigation and mulching should help your${crop || ' crop'}.`,
        actionLabel: 'View soil report',
      });
    }
    if (latest.disease_confidence >= 60 && !latest.disease.startsWith('No significant')) {
      return res.json({
        category: 'pest',
        title: 'Check your crop for disease',
        description: `Your last scan flagged: ${latest.disease.toLowerCase()}. Inspect the plants and consider a neem-oil spray.`,
        actionLabel: 'View soil report',
      });
    }
    const [key, label, remedy] = NUTRIENTS.reduce((lowest, n) => (latest[n[0]] < latest[lowest[0]] ? n : lowest));
    if (latest[key] < 70) {
      return res.json({
        category: 'nutrient',
        title: `Time to boost ${label}`,
        description: `Your last soil scan showed ${label.toLowerCase()} is your weakest nutrient. Try ${remedy} before the next watering.`,
        actionLabel: 'View soil report',
      });
    }
    return res.json({
      category: 'harvest',
      title: 'Your soil is in good shape',
      description: `Your last scan looks healthy. Keep up your routine and rescan in a couple of weeks.`,
      actionLabel: 'View soil report',
    });
  });

  return router;
};
