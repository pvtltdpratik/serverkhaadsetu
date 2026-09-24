// How much one unit of a product weighs, worked out from its unit label
// ("40 kg bag" -> 40, "1 L bottle" -> 1, "per kg" -> 1). Equipment with no
// weight in its label is assumed to be 5 kg, anything else 1 kg. This mirrors
// the backfill in migration 010 so seeded and migrated products agree.
const weightFromLabel = (unitLabel, category) => {
  const label = String(unitLabel || '');
  const kg = label.match(/([0-9]+(?:\.[0-9]+)?)\s*kg/i);
  if (kg) return Number(kg[1]);
  const litres = label.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:l|litre|liter)s?\b/i);
  if (litres) return Number(litres[1]);
  if (/per kg/i.test(label)) return 1;
  return category === 'equipment' ? 5 : 1;
};

module.exports = { weightFromLabel };
