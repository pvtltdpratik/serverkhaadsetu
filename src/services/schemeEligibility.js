const { ageOf } = require('../data/farmerDetails');

// Checks one scheme against what the farmer told us once: their total land and the answers
// in farmer_details. Each rule comes back as one of
//   met      the answers satisfy it
//   notMet   the answers rule the farmer out
//   unknown  we were never told (so the app can ask, and remember the answer)
//   info     a condition we cannot check from a profile (shown, never scored)
// and the scheme as a whole is
//   eligible    every checkable rule is met
//   possible    nothing rules the farmer out, but something is still unknown
//   notEligible at least one rule is not met
//   open        nothing to check (open to all)
const evaluateRule = (rule, { landHa, details }) => {
  const base = { label: rule.label };
  switch (rule.kind) {
    case 'info':
      return { ...base, status: 'info' };
    case 'landMin':
    case 'landMax': {
      if (!(landHa > 0)) return { ...base, status: 'unknown', needs: 'landHoldingHectares' };
      const ok = rule.kind === 'landMax' ? landHa <= rule.hectares : landHa >= rule.hectares;
      return { ...base, status: ok ? 'met' : 'notMet' };
    }
    case 'age': {
      const age = ageOf(details);
      if (age === null) return { ...base, status: 'unknown', needs: 'dateOfBirth' };
      return { ...base, status: age >= rule.min && age <= rule.max ? 'met' : 'notMet' };
    }
    case 'flag': {
      const value = details[rule.key];
      if (typeof value !== 'boolean') return { ...base, status: 'unknown', needs: rule.key };
      return { ...base, status: value === rule.equals ? 'met' : 'notMet' };
    }
    case 'enum': {
      const value = details[rule.key];
      if (value === undefined) return { ...base, status: 'unknown', needs: rule.key };
      const list = Array.isArray(value) ? value : [value];
      return { ...base, status: list.some((v) => rule.in.includes(v)) ? 'met' : 'notMet' };
    }
    default:
      return { ...base, status: 'info' };
  }
};

const evaluate = (scheme, { landHa = 0, details = {} } = {}) => {
  const checks = (scheme.rules || []).map((r) => evaluateRule(r, { landHa, details }));
  const checkable = checks.filter((c) => c.status !== 'info');
  const met = checkable.filter((c) => c.status === 'met').length;
  const unknown = checkable.filter((c) => c.status === 'unknown');
  let status;
  if (!checkable.length) status = 'open';
  else if (checkable.some((c) => c.status === 'notMet')) status = 'notEligible';
  else if (unknown.length) status = 'possible';
  else status = 'eligible';
  return {
    schemeId: scheme.id,
    status,
    met,
    total: checkable.length,
    missing: [...new Set(unknown.map((c) => c.needs))],
    checks,
  };
};

module.exports = { evaluate };
