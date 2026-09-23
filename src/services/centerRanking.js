// Pure ranking logic for "which village center should this farmer use?" — no
// database, no clock of its own, so every rule can be tested directly.
//
// A center's score blends four things (weights sum to 1):
//   distance     40%   closer is better
//   inventory    35%   how much of the farmer's cart the center can actually give
//   operational  15%   open now? how backed-up is it?
//   historical   10%   past ratings / waits / stockouts (neutral until we have data)
// A farmer's home center then gets a 20% bonus.

const WEIGHTS = { distance: 0.4, inventory: 0.35, operational: 0.15, historical: 0.1 };

// Adaptive search radius: try 10 km, widen to 20, then 35 until at least
// MIN_CENTERS turn up, so there are always options without showing centers
// 100 km away.
const RADII_KM = [10, 20, 35];
const MIN_CENTERS = 2;

const NEAR_KM = 2; // at or under this a center gets the full distance score
const FAR_KM = 35; // at or beyond this it gets none
const HOME_BONUS = 1.2;
const NEUTRAL = 50;
const MAX_PENDING_FOR_LOAD = 50;
const SOON_MINUTES = 12 * 60;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const round1 = (v) => Math.round(v * 10) / 10;

// `distancesKm` is every candidate's distance. Returns the smallest radius
// holding MIN_CENTERS or more; if even the widest doesn't, the widest.
const pickRadius = (distancesKm) => {
  for (const radius of RADII_KM) {
    if (distancesKm.filter((d) => d <= radius).length >= MIN_CENTERS) return radius;
  }
  return RADII_KM[RADII_KM.length - 1];
};

// 100 within NEAR_KM, falling in a straight line to 0 at FAR_KM.
const distanceScore = (km) => clamp(100 * (1 - (km - NEAR_KM) / (FAR_KM - NEAR_KM)), 0, 100);

// How well a center covers the cart. `requests` is [{productId, quantity}];
// `available` maps productId -> units available (on hand minus reserved).
//   ratio          average of min(available/requested, 1): partial cover counts partially
//   availableItems how many lines are fully covered (drives "2 of 4 items available")
//   status         'all' | 'partial' | 'none', or null when there is no cart
const inventoryMatch = (requests, available) => {
  if (!requests || !requests.length) return { status: null, ratio: null, availableItems: 0, totalItems: 0, items: [] };
  const items = requests.map((r) => {
    const have = available.get(r.productId) || 0;
    return { productId: r.productId, requested: r.quantity, available: have, isFullyAvailable: have >= r.quantity };
  });
  const ratio = items.reduce((sum, i) => sum + Math.min(i.available / i.requested, 1), 0) / items.length;
  const availableItems = items.filter((i) => i.isFullyAvailable).length;
  const status = availableItems === items.length ? 'all' : ratio === 0 ? 'none' : 'partial';
  return { status, ratio, availableItems, totalItems: items.length, items };
};

const inventoryLabel = (m) => {
  if (m.status === null) return null;
  if (m.status === 'all') return 'All items available';
  if (m.status === 'none') return 'Out of stock for your order';
  return `${m.availableItems} of ${m.totalItems} items available`;
};

// With no cart there is nothing to match, so every center scores the same here
// and distance/operations decide.
const inventoryScore = (m) => (m.ratio === null ? NEUTRAL : m.ratio * 100);

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// Minutes since local midnight in `timeZone` (centers are judged on their own
// clock, not the server's).
const minutesNow = (now, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get('hour') * 60 + get('minute');
};

// Open/closed and a human label. A center is open only if the operator has it
// switched on AND it is inside today's hours.
const hoursStatus = ({ isOpen, opensAt, closesAt }, now, timeZone) => {
  const mins = minutesNow(now, timeZone);
  const open = toMinutes(opensAt);
  const close = toMinutes(closesAt);
  const withinHours = mins >= open && mins < close;
  const isOpenNow = Boolean(isOpen) && withinHours;
  const minutesUntilOpen = withinHours ? 0 : (open - mins + 1440) % 1440;
  let label;
  if (!isOpen) label = 'Closed by operator';
  else if (isOpenNow) label = `Open until ${closesAt}`;
  else if (mins < open) label = `Opens today at ${opensAt}`;
  else label = `Opens tomorrow at ${opensAt}`;
  return { isOpenNow, isSwitchedOn: Boolean(isOpen), opensAt, closesAt, minutesUntilOpen, label };
};

// 60 points for being open (30 if switched on and opening within 12 hours, so
// a farmer can realistically visit), plus up to 40 for a short queue.
const operationalScore = (hours, pendingPickups) => {
  const status = hours.isOpenNow ? 60 : hours.isSwitchedOn && hours.minutesUntilOpen <= SOON_MINUTES ? 30 : 0;
  const load = 40 * (1 - Math.min(pendingPickups, MAX_PENDING_FOR_LOAD) / MAX_PENDING_FOR_LOAD);
  return status + load;
};

// Ratings, average pickup wait and 30-day stockouts are not recorded yet, so
// every center is neutral. The inputs are accepted so the signature will not
// change when that data exists.
// eslint-disable-next-line no-unused-vars
const historicalScore = (_history) => NEUTRAL;

const compositeScore = (s) =>
  s.distance * WEIGHTS.distance + s.inventory * WEIGHTS.inventory + s.operational * WEIGHTS.operational + s.historical * WEIGHTS.historical;

const withHomeBonus = (score, isHome) => (isHome ? Math.min(score * HOME_BONUS, 100) : score);

// Best first. A center that has none of the cart is placed below every center
// that has something, however close it is: sending a farmer to an empty shelf
// is the worst outcome. Ties fall back to the nearer center.
const compareCenters = (a, b) => {
  const aEmpty = a.inventory.status === 'none';
  const bEmpty = b.inventory.status === 'none';
  if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
  return b.scores.total - a.scores.total || a.distanceKm - b.distanceKm;
};

// Plain-language reason shown under "Recommended Center".
const recommendationReason = (top, all) => {
  const km = `${top.distanceKm} km`;
  const m = top.inventory;
  let reason;
  if (m.status === 'all') {
    const nearestWithAll = Math.min(...all.filter((c) => c.inventory.status === 'all').map((c) => c.distanceKm));
    reason = top.distanceKm === nearestWithAll ? 'Closest center with all your items in stock' : `All your items in stock, ${km} away`;
  } else if (m.status === 'partial') {
    reason = `${km} away, ${m.availableItems} of ${m.totalItems} items available`;
  } else if (m.status === 'none') {
    reason = `${km} away, but none of your items are in stock right now`;
  } else {
    const nearest = Math.min(...all.map((c) => c.distanceKm));
    const closest = top.distanceKm === nearest;
    reason = top.hours.isOpenNow ? (closest ? 'Closest open center' : `Open now, ${km} away`) : closest ? 'Closest center' : `Best overall match, ${km} away`;
  }
  return top.isHomeCenter ? `Your home center: ${reason}` : reason;
};

module.exports = {
  WEIGHTS, RADII_KM, MIN_CENTERS, NEAR_KM, FAR_KM, HOME_BONUS, NEUTRAL,
  pickRadius, distanceScore, inventoryMatch, inventoryLabel, inventoryScore, hoursStatus, minutesNow,
  operationalScore, historicalScore, compositeScore, withHomeBonus, compareCenters, recommendationReason, round1,
};
