const express = require('express');
const { HttpError, deviceId, sendList } = require('../utils/http');

module.exports = (store) => {
  const router = express.Router();

  const findScheme = (id) => {
    const scheme = store.data.schemes.find((s) => s.id === id);
    if (!scheme) throw new HttpError(404, 'Scheme not found');
    return scheme;
  };

  const applicationFor = (device, schemeId) =>
    store.data.applications.find((a) => a.deviceId === device && a.schemeId === schemeId);

  const publicApplication = (schemeId, a) => ({
    schemeId,
    status: a ? a.status : 'notApplied',
    appliedDate: a ? a.appliedDate : null,
  });

  router.get('/', (req, res) => sendList(req, res, store.data.schemes));

  router.get('/applications', (req, res) => {
    const device = deviceId(req);
    sendList(
      req,
      res,
      store.data.applications.filter((a) => a.deviceId === device).map((a) => publicApplication(a.schemeId, a)),
    );
  });

  router.get('/:id', (req, res) => res.json(findScheme(req.params.id)));

  router.get('/:id/application', (req, res) => {
    const scheme = findScheme(req.params.id);
    res.json(publicApplication(scheme.id, applicationFor(deviceId(req), scheme.id)));
  });

  router.post('/:id/apply', (req, res) => {
    const scheme = findScheme(req.params.id);
    const device = deviceId(req);

    if (scheme.applicationDeadline && new Date(scheme.applicationDeadline).getTime() < Date.now()) {
      throw new HttpError(400, 'The application deadline for this scheme has passed');
    }
    const profile = store.data.profiles.find((p) => p.deviceId === device);
    if (profile && scheme.maxLandHoldingHectares !== null && profile.landHoldingHectares > scheme.maxLandHoldingHectares) {
      throw new HttpError(403, `This scheme is limited to land holdings up to ${scheme.maxLandHoldingHectares} hectares`);
    }

    let application = applicationFor(device, scheme.id);
    // Re-applying is a no-op unless the earlier application was rejected.
    if (application && application.status !== 'rejected') return res.json(publicApplication(scheme.id, application));

    if (!application) {
      application = { deviceId: device, schemeId: scheme.id };
      store.data.applications.push(application);
    }
    application.status = 'submitted';
    application.appliedDate = new Date().toISOString();
    store.save();
    res.status(201).json(publicApplication(scheme.id, application));
  });

  return router;
};
