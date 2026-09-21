const express = require('express');
const { HttpError, asyncHandler, deviceId, sendPaged } = require('../utils/http');
const { notify } = require('../services/notifications');

const SCHEME_COLUMNS = `id, name, agency, category, description, benefit, eligibility_criteria AS "eligibilityCriteria",
  max_land_holding_hectares AS "maxLandHoldingHectares", application_deadline AS "applicationDeadline"`;

const publicApplication = (schemeId, a) => ({
  schemeId,
  status: a ? a.status : 'notApplied',
  appliedDate: a ? a.appliedDate : null,
});

module.exports = (db) => {
  const router = express.Router();
  const ah = asyncHandler;

  const findScheme = async (id, q = db) => {
    const { rows } = await q.query(`SELECT ${SCHEME_COLUMNS} FROM schemes WHERE id = $1`, [id]);
    if (!rows.length) throw new HttpError(404, 'Scheme not found');
    return rows[0];
  };

  const applicationFor = async (q, owner, schemeId) =>
    (await q.query('SELECT status, applied_date AS "appliedDate" FROM scheme_applications WHERE owner_id = $1 AND scheme_id = $2', [owner, schemeId])).rows[0];

  router.get('/', ah(async (req, res) => {
    await sendPaged(req, res, db, { select: SCHEME_COLUMNS, from: 'schemes', order: 'seq' });
  }));

  // Declared before '/:id' so the word "applications" is not read as a scheme id.
  router.get('/applications', ah(async (req, res) => {
    await sendPaged(req, res, db, {
      select: 'scheme_id AS "schemeId", status, applied_date AS "appliedDate"',
      from: 'scheme_applications WHERE owner_id = $1',
      params: [deviceId(req)],
      order: 'applied_date DESC, scheme_id',
    });
  }));

  router.get('/:id', ah(async (req, res) => res.json(await findScheme(req.params.id))));

  router.get('/:id/application', ah(async (req, res) => {
    const scheme = await findScheme(req.params.id);
    res.json(publicApplication(scheme.id, await applicationFor(db, deviceId(req), scheme.id)));
  }));

  router.post('/:id/apply', ah(async (req, res) => {
    const owner = deviceId(req);
    const { status, body } = await db.tx(async (c) => {
      const scheme = await findScheme(req.params.id, c);

      if (scheme.applicationDeadline && new Date(scheme.applicationDeadline).getTime() < Date.now()) {
        throw new HttpError(400, 'The application deadline for this scheme has passed');
      }
      const profile = (await c.query('SELECT land_holding_hectares AS "land" FROM profiles WHERE owner_id = $1', [owner])).rows[0];
      if (profile && scheme.maxLandHoldingHectares !== null && profile.land > scheme.maxLandHoldingHectares) {
        throw new HttpError(403, `This scheme is limited to land holdings up to ${scheme.maxLandHoldingHectares} hectares`);
      }

      // Serialise per owner and scheme so a double-tap cannot submit twice.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`apply:${owner}:${scheme.id}`]);
      const existing = await applicationFor(c, owner, scheme.id);
      // Re-applying is a no-op unless the earlier application was rejected.
      if (existing && existing.status !== 'rejected') return { status: 200, body: publicApplication(scheme.id, existing) };

      const { rows } = await c.query(
        `INSERT INTO scheme_applications (owner_id, scheme_id, status, applied_date) VALUES ($1,$2,'submitted', now())
         ON CONFLICT (owner_id, scheme_id) DO UPDATE SET status = 'submitted', applied_date = now()
         RETURNING status, applied_date AS "appliedDate"`,
        [owner, scheme.id],
      );
      await notify(c, owner, {
        type: 'scheme',
        title: 'Application submitted',
        body: `Your application for ${scheme.name} has been submitted and is awaiting review.`,
        refId: scheme.id,
      });
      return { status: 201, body: publicApplication(scheme.id, rows[0]) };
    });
    res.status(status).json(body);
  }));

  return router;
};
