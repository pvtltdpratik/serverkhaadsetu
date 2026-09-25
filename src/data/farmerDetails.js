const { HttpError } = require('../utils/http');

// What a farmer tells us once so schemes can be checked without asking again.
// Each key has a type; the server keeps only these keys and only valid values, so
// the stored document can be trusted by the eligibility rules.
const YES_NO = 'bool';

const FIELDS = {
  category: { type: 'enum', values: ['general', 'obc', 'sc', 'st'] },
  gender: { type: 'enum', values: ['male', 'female', 'other'] },
  dateOfBirth: { type: 'date' },
  landOwnership: { type: 'enum', values: ['owner', 'tenant', 'sharecropper', 'none'] },
  nameInLandRecords: { type: YES_NO },
  hasBankAccount: { type: YES_NO },
  hasAadhaar: { type: YES_NO },
  hasKcc: { type: YES_NO },
  hasCropLoan: { type: YES_NO },
  irrigation: { type: 'enum', values: ['rainfed', 'well', 'borewell', 'canal', 'drip', 'sprinkler'] },
  soilType: { type: 'enum', values: ['black', 'red', 'alluvial', 'laterite', 'sandy', 'other'] },
  primaryCrops: { type: 'list' },
  ownsPumpset: { type: YES_NO },
  ownsTractor: { type: YES_NO },
  hasSchoolChildren: { type: YES_NO },
  // Exclusions that matter for PM-KISAN.
  isIncomeTaxPayer: { type: YES_NO },
  isGovtEmployee: { type: YES_NO },
  hasPensionOf10kOrMore: { type: YES_NO },
  holdsConstitutionalPost: { type: YES_NO },
  isRegisteredProfessional: { type: YES_NO },
  isNri: { type: YES_NO },
  isInstitutionalLandholder: { type: YES_NO },
  // Organic farming.
  practisesOrganic: { type: YES_NO },
  inFarmerGroup: { type: YES_NO },
};

const KEYS = Object.keys(FIELDS);

const isoDay = (v) => {
  const parsed = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
  return parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(v) ? parsed : null;
};

// Cleans one submitted value; null means "forget this answer".
const clean = (key, value) => {
  if (value === null) return null;
  const spec = FIELDS[key];
  switch (spec.type) {
    case 'bool':
      if (typeof value !== 'boolean') throw new HttpError(400, `"${key}" must be true or false`);
      return value;
    case 'enum':
      if (!spec.values.includes(value)) throw new HttpError(400, `"${key}" must be one of: ${spec.values.join(', ')}`);
      return value;
    case 'date': {
      const d = isoDay(value);
      const age = d ? (Date.now() - d.getTime()) / (365.25 * 86400000) : -1;
      if (!d || age < 5 || age > 110) throw new HttpError(400, `"${key}" must be a real date of birth like 1985-06-30`);
      return value;
    }
    case 'list': {
      if (!Array.isArray(value) || value.length > 20 || value.some((x) => typeof x !== 'string' || !x.trim() || x.length > 40)) {
        throw new HttpError(400, `"${key}" must be a list of up to 20 short names`);
      }
      return [...new Set(value.map((x) => x.trim()))];
    }
    default:
      return value;
  }
};

// Merges a partial update into what is stored. Unknown keys are a client bug, so
// they are refused rather than silently dropped.
const mergeDetails = (current, input) => {
  const next = { ...current };
  for (const [key, value] of Object.entries(input)) {
    if (!FIELDS[key]) throw new HttpError(400, `Unknown detail "${key}"`);
    const cleaned = clean(key, value);
    if (cleaned === null) delete next[key];
    else next[key] = cleaned;
  }
  return next;
};

const ageOf = (details, now = Date.now()) => {
  const d = details.dateOfBirth ? isoDay(details.dateOfBirth) : null;
  return d ? Math.floor((now - d.getTime()) / (365.25 * 86400000)) : null;
};

module.exports = { FIELDS, KEYS, mergeDetails, ageOf };
