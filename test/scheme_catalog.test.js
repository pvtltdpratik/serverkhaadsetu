process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.RATE_LIMIT_OTP = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');

const { catalog } = require('../src/data/schemeCatalog');
const { FIELDS } = require('../src/data/farmerDetails');
const { evaluate } = require('../src/services/schemeEligibility');

let server;
let base;
let db;

const call = async (method, path, { body, device = 's-1' } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-device-id': device },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
};

test.before(async () => {
  const { openTestDb } = require('./helpers');
  const { createApp } = require('../src/app');
  const { syncSchemeCatalog } = require('../src/services/schemeCatalogSync');
  db = await openTestDb('t_scheme_catalog');
  await syncSchemeCatalog(db);
  await syncSchemeCatalog(db); // running it again must change nothing
  server = createApp(db).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await require('./helpers').closeTestDb(db);
});

const PM_KISAN_ELIGIBLE = {
  landOwnership: 'owner', nameInLandRecords: true, isInstitutionalLandholder: false, holdsConstitutionalPost: false, isGovtEmployee: false,
  hasPensionOf10kOrMore: false, isIncomeTaxPayer: false, isRegisteredProfessional: false, isNri: false, hasBankAccount: true,
};

test('the catalog is well formed: unique ids, known rule keys, real amounts on every scheme', () => {
  const ids = catalog.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(catalog.length >= 40, 'the guides give a lot of schemes');
  const categories = ['incomeSupport', 'insurance', 'subsidy', 'creditSupport', 'training', 'marketing', 'livestock', 'processing'];
  for (const s of catalog) {
    assert.ok(categories.includes(s.category), `${s.id} category`);
    assert.ok(['central', 'state'].includes(s.level), `${s.id} level`);
    assert.ok(['farmer', 'group', 'enterprise'].includes(s.audience), `${s.id} audience`);
    assert.ok(s.description.length > 20 && s.benefit.length > 5, `${s.id} text`);
    assert.ok(s.eligibilityCriteria.length >= 1, `${s.id} criteria`);
    assert.ok(s.components.length >= 1, `${s.id} components`);
    for (const c of s.components) assert.ok(c.title && c.assistance, `${s.id} component ${c.title}`);
    for (const r of s.rules) {
      assert.ok(r.label, `${s.id} rule label`);
      if (r.kind === 'flag' || r.kind === 'enum') {
        assert.ok(FIELDS[r.key], `${s.id} rule uses unknown answer "${r.key}"`);
        if (r.kind === 'enum') assert.ok(r.in.length > 0, `${s.id} enum rule has values`);
        if (r.kind === 'enum' && FIELDS[r.key].type === 'enum') {
          for (const v of r.in) assert.ok(FIELDS[r.key].values.includes(v), `${s.id} "${v}" is not a value of ${r.key}`);
        }
        if (r.kind === 'flag') assert.equal(FIELDS[r.key].type, 'bool', `${s.id} ${r.key} is a yes/no`);
      }
    }
  }
});

test('the programmes from all four guides are there, with their published amounts', () => {
  const by = (id) => catalog.find((s) => s.id === id);
  const has = (id, text) => assert.ok(JSON.stringify(by(id)).includes(text), `${id} should mention ${text}`);
  has('scheme-pmkisan', '₹6,000');
  has('scheme-fasalbima', '1.5% of the sum insured');
  has('scheme-fasalbima', '5% of the sum insured');
  has('scheme-pmsby', '₹12');
  has('scheme-pmjjby', '₹330');
  has('scheme-kcc', '₹3 lakh');
  has('scheme-soil-health', '₹15 per sample');
  has('scheme-seed-subsidy', '₹12 per kg');
  has('scheme-rainfed-irrigation', '₹60,000');
  has('scheme-machinery-support', '₹45,000');
  has('scheme-training-atma', '₹750');
  has('scheme-pgs-india', 'At least 5 farmers');
  has('scheme-price-support', '90 days');
  has('scheme-deds', '33.33%');
  has('scheme-cold-chain', '₹10 crore');
  has('scheme-organic-units', '₹63 lakh');
});

test('rules: PM-KISAN with every answer in is eligible; one failed exclusion rules the family out', () => {
  const pmkisan = catalog.find((s) => s.id === 'scheme-pmkisan');
  const ok = evaluate(pmkisan, { landHa: 1.5, details: PM_KISAN_ELIGIBLE });
  assert.equal(ok.status, 'eligible');
  assert.equal(ok.met, ok.total);
  assert.deepEqual(ok.missing, []);

  const taxpayer = evaluate(pmkisan, { landHa: 1.5, details: { ...PM_KISAN_ELIGIBLE, isIncomeTaxPayer: true } });
  assert.equal(taxpayer.status, 'notEligible');
  assert.equal(taxpayer.checks.filter((c) => c.status === 'notMet').map((c) => c.label)[0], 'No family member paid income tax last year');

  const tenant = evaluate(pmkisan, { landHa: 1, details: { ...PM_KISAN_ELIGIBLE, landOwnership: 'tenant' } });
  assert.equal(tenant.status, 'notEligible', 'PM-KISAN is for the landowning family');
});

test('rules: what we have not been told is unknown, never a pass, and is listed so the app can ask', () => {
  const pmkisan = catalog.find((s) => s.id === 'scheme-pmkisan');
  const none = evaluate(pmkisan, { landHa: 0, details: {} });
  assert.equal(none.status, 'possible');
  assert.equal(none.met, 0);
  assert.ok(none.missing.includes('landOwnership'));
  assert.ok(none.missing.includes('isIncomeTaxPayer'));

  const pkvy = catalog.find((s) => s.id === 'scheme-pkvy');
  const noLand = evaluate(pkvy, { landHa: 0, details: {} });
  assert.ok(noLand.missing.includes('landHoldingHectares'));
  assert.equal(evaluate(pkvy, { landHa: 3, details: {} }).status, 'notEligible', 'a land cap that is exceeded is a clear no');
  assert.equal(evaluate(pkvy, { landHa: 1.5, details: { inFarmerGroup: true, practisesOrganic: true } }).status, 'eligible');
});

test('rules: age comes from the date of birth, and info lines are shown but not scored', () => {
  const pmsby = catalog.find((s) => s.id === 'scheme-pmsby');
  const young = evaluate(pmsby, { details: { dateOfBirth: '2015-01-01', hasBankAccount: true, hasAadhaar: true } });
  assert.equal(young.status, 'notEligible');
  const yearsAgo = (n) => `${new Date().getUTCFullYear() - n}-01-02`;
  assert.equal(evaluate(pmsby, { details: { dateOfBirth: yearsAgo(40), hasBankAccount: true, hasAadhaar: true } }).status, 'eligible');
  const pmjjby = catalog.find((s) => s.id === 'scheme-pmjjby');
  assert.equal(evaluate(pmjjby, { details: { dateOfBirth: yearsAgo(60), hasBankAccount: true } }).status, 'notEligible', 'over 50');

  const fasal = catalog.find((s) => s.id === 'scheme-fasalbima');
  const r = evaluate(fasal, { landHa: 1, details: { landOwnership: 'owner', hasCropLoan: false } });
  assert.equal(r.status, 'eligible');
  assert.equal(r.checks.filter((c) => c.status === 'info').length, 2);
  assert.equal(evaluate(fasal, { landHa: 1, details: { landOwnership: 'owner', hasCropLoan: true } }).status, 'eligible', 'a crop loan does not change eligibility');
  assert.equal(evaluate(catalog.find((s) => s.id === 'scheme-agmarknet'), {}).status, 'open');
});

test('rules: SC/ST-only and women-only programmes read the category and gender answers', () => {
  const scp = catalog.find((s) => s.id === 'scheme-scp-tsp-irrigation');
  assert.equal(evaluate(scp, { landHa: 1, details: { category: 'st' } }).status, 'eligible');
  assert.equal(evaluate(scp, { landHa: 1, details: { category: 'general' } }).status, 'notEligible');
  assert.ok(evaluate(scp, { landHa: 1, details: {} }).missing.includes('category'));
});

test('the catalog is in the database once, and the older schemes keep their ids', async () => {
  const all = (await call('GET', '/v1/schemes?limit=200')).json;
  assert.equal(all.length, catalog.length);
  assert.equal(Number(all.length), Number((await db.query('SELECT count(*) FROM schemes')).rows[0].count));
  const pmkisan = all.find((s) => s.id === 'scheme-pmkisan');
  assert.equal(pmkisan.sector, 'Income support');
  assert.ok(pmkisan.components.length >= 3);
  assert.ok(pmkisan.howToApply.includes('PM-KISAN portal'));
  assert.equal(all.find((s) => s.id === 'scheme-pkvy').maxLandHoldingHectares, 2);
  assert.equal(all.find((s) => s.id === 'scheme-mechanization').maxLandHoldingHectares, 1);
});

test('the list can be filtered by sector, level, audience and words', async () => {
  const soil = (await call('GET', '/v1/schemes?sector=' + encodeURIComponent('Soil & fertilizer'))).json;
  assert.ok(soil.length >= 5);
  assert.ok(soil.every((s) => s.sector === 'Soil & fertilizer'));
  const state = (await call('GET', '/v1/schemes?level=state&limit=200')).json;
  assert.ok(state.length > 5 && state.every((s) => s.level === 'state'));
  const farmerOnly = (await call('GET', '/v1/schemes?audience=farmer&limit=200')).json;
  assert.ok(farmerOnly.every((s) => s.audience === 'farmer'));
  const found = (await call('GET', '/v1/schemes?q=vermicompost')).json;
  assert.ok(found.some((s) => s.id === 'scheme-organic-farming'));
  assert.equal((await call('GET', '/v1/schemes?q=zzzz-nothing')).json.length, 0);
});

test('eligibility reads the answers stored on the profile, so nothing is asked twice', async () => {
  const d = 'elig-farmer';
  const first = (await call('GET', '/v1/schemes/scheme-pmkisan/eligibility', { device: d })).json;
  assert.equal(first.status, 'possible');
  assert.ok(first.missing.length >= 5);

  await call('PUT', '/v1/farmer/profile', { device: d, body: { landHoldingHectares: 1.5 } });
  await call('PUT', '/v1/farmer/details', { device: d, body: PM_KISAN_ELIGIBLE });
  const second = (await call('GET', '/v1/schemes/scheme-pmkisan/eligibility', { device: d })).json;
  assert.equal(second.status, 'eligible');

  // Those same answers now serve every other scheme too.
  const summary = (await call('GET', '/v1/schemes/eligibility', { device: d })).json;
  assert.equal(summary.length, catalog.length);
  assert.equal(summary.find((e) => e.schemeId === 'scheme-pmkisan').status, 'eligible');
  const kcc = summary.find((e) => e.schemeId === 'scheme-kcc');
  assert.equal(kcc.status, 'eligible', 'the land and bank answers from PM-KISAN also satisfy the Kisan Credit Card');
  assert.equal(summary.find((e) => e.schemeId === 'scheme-pkvy').status, 'possible', 'group and organic answers are still missing');
  assert.equal((await call('GET', '/v1/schemes/nope/eligibility', { device: d })).status, 404);
});

test('applying is refused when the saved answers clearly rule you out, and allowed when they do not', async () => {
  const d = 'rich-family';
  await call('PUT', '/v1/farmer/profile', { device: d, body: { landHoldingHectares: 1 } });
  await call('PUT', '/v1/farmer/details', { device: d, body: { ...PM_KISAN_ELIGIBLE, isIncomeTaxPayer: true } });
  const refused = await call('POST', '/v1/schemes/scheme-pmkisan/apply', { device: d });
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /income tax/);
  assert.deepEqual(refused.json.failed, ['No family member paid income tax last year']);

  // A different farmer who has told us nothing yet is allowed: unknown is not a no.
  assert.equal((await call('POST', '/v1/schemes/scheme-pmkisan/apply', { device: 'new-farmer' })).status, 201);
  await call('PUT', '/v1/farmer/details', { device: d, body: { isIncomeTaxPayer: false } });
  assert.equal((await call('POST', '/v1/schemes/scheme-pmkisan/apply', { device: d })).status, 201);
});
