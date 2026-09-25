const express = require('express');
const { HttpError, asyncHandler, deviceId, sendPaged } = require('../utils/http');
const { notify } = require('../services/notifications');
const { evaluate } = require('../services/schemeEligibility');
const { likePattern } = require('../utils/http');

const SCHEME_COLUMNS = `id, name, agency, category, description, benefit, eligibility_criteria AS "eligibilityCriteria",
  max_land_holding_hectares AS "maxLandHoldingHectares", application_deadline AS "applicationDeadline",
  level, sector, audience, components, how_to_apply AS "howToApply", contact, website`;

// Rules are read by the server only; the app gets the outcome, not the rule book.
const RULE_COLUMNS = `${SCHEME_COLUMNS}, rules`;

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

  // What the farmer has told us once: total land and the saved answers.
  const farmerFacts = async (q, owner) => {
    const land = (await q.query('SELECT land_holding_hectares AS "land" FROM profiles WHERE owner_id = $1', [owner])).rows[0];
    const details = (await q.query('SELECT data FROM farmer_details WHERE owner_id = $1', [owner])).rows[0];
    return { landHa: land ? Number(land.land) : 0, details: details ? details.data : {} };
  };

  const strip = (e) => ({ schemeId: e.schemeId, status: e.status, met: e.met, total: e.total, missing: e.missing });

  router.get('/', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.sector) { params.push(String(req.query.sector)); where.push(`sector = $${params.length}`); }
    if (req.query.level) { params.push(String(req.query.level)); where.push(`level = $${params.length}`); }
    if (req.query.audience) { params.push(String(req.query.audience)); where.push(`audience = $${params.length}`); }
    if (req.query.q) { params.push(likePattern(req.query.q)); where.push(`(name || ' ' || description || ' ' || sector) ILIKE $${params.length}`); }
    await sendPaged(req, res, db, { select: SCHEME_COLUMNS, from: `schemes${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`, params, order: 'seq' });
  }));

  // How the signed-in farmer stands against every scheme, from their saved answers.
  // Declared before '/:id' so "eligibility" is not read as a scheme id.
  router.get('/eligibility', ah(async (req, res) => {
    const facts = await farmerFacts(db, deviceId(req));
    const schemes = (await db.query(`SELECT ${RULE_COLUMNS} FROM schemes ORDER BY seq`)).rows;
    res.json(schemes.map((s) => strip(evaluate(s, facts))));
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

  router.get('/:id/eligibility', ah(async (req, res) => {
    const scheme = (await db.query(`SELECT ${RULE_COLUMNS} FROM schemes WHERE id = $1`, [req.params.id])).rows[0];
    if (!scheme) throw new HttpError(404, 'Scheme not found');
    res.json(evaluate(scheme, await farmerFacts(db, deviceId(req))));
  }));

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

      // A rule the farmer's own answers fail is a clear no; unknown answers are not held against them.
      const outcome = evaluate((await c.query(`SELECT ${RULE_COLUMNS} FROM schemes WHERE id = $1`, [scheme.id])).rows[0], await farmerFacts(c, owner));
      if (outcome.status === 'notEligible') {
        const failed = outcome.checks.find((k) => k.status === 'notMet');
        throw new HttpError(403, `Your saved answers do not meet this scheme: ${failed.label}`, { failed: outcome.checks.filter((k) => k.status === 'notMet').map((k) => k.label) });
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
