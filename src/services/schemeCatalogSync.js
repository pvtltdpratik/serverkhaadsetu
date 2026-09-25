const { catalog } = require('../data/schemeCatalog');

// Puts the catalog in the database: new schemes are inserted, existing ones (matched by id)
// get their descriptive fields refreshed. An application deadline or land cap that an admin or
// the first seed set is left alone. Safe to run on every start.
const syncSchemeCatalog = async (db) => {
  await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(727210)');
    for (const s of catalog) {
      await c.query(
        `INSERT INTO schemes (id, name, agency, category, description, benefit, eligibility_criteria, level, sector, audience,
                              components, rules, how_to_apply, contact, website, source, max_land_holding_hectares)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, agency = EXCLUDED.agency, category = EXCLUDED.category, description = EXCLUDED.description,
           benefit = EXCLUDED.benefit, eligibility_criteria = EXCLUDED.eligibility_criteria, level = EXCLUDED.level,
           sector = EXCLUDED.sector, audience = EXCLUDED.audience, components = EXCLUDED.components, rules = EXCLUDED.rules,
           how_to_apply = EXCLUDED.how_to_apply, contact = EXCLUDED.contact, website = EXCLUDED.website, source = EXCLUDED.source`,
        [
          s.id, s.name, s.agency, s.category, s.description, s.benefit, s.eligibilityCriteria, s.level, s.sector, s.audience,
          JSON.stringify(s.components || []), JSON.stringify(s.rules || []), s.howToApply || '', s.contact || '', s.website || '', s.source || '',
          // Only a cap that the rules state outright (a land-size ceiling) becomes the hard limit on apply.
          (s.rules || []).find((r) => r.kind === 'landMax')?.hectares ?? null,
        ],
      );
    }
  });
  return catalog.length;
};

module.exports = { syncSchemeCatalog };
