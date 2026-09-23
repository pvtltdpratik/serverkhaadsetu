const test = require('node:test');
const assert = require('node:assert/strict');
const { haversineKm, boundingBox, estimateTravelMinutes } = require('../src/services/geo');
const r = require('../src/services/centerRanking');
const { findVillage, searchVillages } = require('../src/data/villages');

const near = (actual, expected, tolerance, msg) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${msg || ''} expected ${expected} +/- ${tolerance}, got ${actual}`);

test('haversine: known distances, symmetry, zero, and longitude shrinking with latitude', () => {
  const pune = { latitude: 18.5204, longitude: 73.8567 };
  const mumbai = { latitude: 19.076, longitude: 72.8777 };
  const delhi = { latitude: 28.6139, longitude: 77.209 };
  near(haversineKm(pune, mumbai), 120, 5, 'Pune-Mumbai');
  near(haversineKm(delhi, mumbai), 1153, 12, 'Delhi-Mumbai');
  assert.equal(haversineKm(pune, pune), 0);
  assert.equal(haversineKm(pune, mumbai), haversineKm(mumbai, pune));
  // One degree of longitude: ~111.2 km at the equator, about half that at 60 degrees north.
  near(haversineKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }), 111.19, 0.1);
  near(haversineKm({ latitude: 60, longitude: 0 }, { latitude: 60, longitude: 1 }), 55.6, 0.2);
});

test('bounding box contains every point within the radius', () => {
  const origin = { latitude: 18.5, longitude: 74 };
  const box = boundingBox(origin, 35);
  for (let bearing = 0; bearing < 360; bearing += 15) {
    // A point 34.9 km away in this direction (small-angle offsets are fine at this scale).
    const rad = (bearing * Math.PI) / 180;
    const p = {
      latitude: origin.latitude + (34.9 / 111.19) * Math.cos(rad),
      longitude: origin.longitude + ((34.9 / 111.19) * Math.sin(rad)) / Math.cos((origin.latitude * Math.PI) / 180),
    };
    assert.ok(p.latitude >= box.minLat && p.latitude <= box.maxLat && p.longitude >= box.minLng && p.longitude <= box.maxLng, `bearing ${bearing}`);
  }
  assert.ok(Number.isFinite(boundingBox({ latitude: 89.99, longitude: 0 }, 35).maxLng), 'no blow-up at the poles');
});

test('travel time is a distance-based estimate, never zero', () => {
  assert.equal(estimateTravelMinutes(10), 26);
  assert.equal(estimateTravelMinutes(0), 1);
  assert.ok(estimateTravelMinutes(20) > estimateTravelMinutes(10));
});

test('adaptive radius: 10, then 20, then 35 km, until two centers are found', () => {
  assert.equal(r.pickRadius([1, 3]), 10);
  assert.equal(r.pickRadius([3, 9, 11]), 10);
  assert.equal(r.pickRadius([5, 15]), 20);
  assert.equal(r.pickRadius([12, 18]), 20);
  assert.equal(r.pickRadius([5, 25, 30]), 35);
  assert.equal(r.pickRadius([10, 10.1]), 20, 'the boundary is inclusive');
  assert.equal(r.pickRadius([5]), 35, 'one center is not enough, so widen (and stay at the widest)');
  assert.equal(r.pickRadius([]), 35);
});

test('distance score: full up to 2 km, straight line down to zero at 35 km', () => {
  assert.equal(r.distanceScore(0), 100);
  assert.equal(r.distanceScore(2), 100);
  assert.equal(r.distanceScore(18.5), 50);
  assert.equal(r.distanceScore(35), 0);
  assert.equal(r.distanceScore(80), 0);
  assert.ok(r.distanceScore(5) > r.distanceScore(15));
});

test('inventory match: fully covered, partly covered, and empty', () => {
  const cart = [{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 1 }, { productId: 'c', quantity: 4 }, { productId: 'd', quantity: 1 }];
  const all = r.inventoryMatch(cart, new Map([['a', 5], ['b', 1], ['c', 4], ['d', 9]]));
  assert.equal(all.status, 'all');
  assert.equal(r.inventoryLabel(all), 'All items available');
  assert.equal(r.inventoryScore(all), 100);

  const some = r.inventoryMatch(cart, new Map([['a', 2], ['b', 1], ['c', 2]]));
  assert.equal(some.status, 'partial');
  assert.equal(some.availableItems, 2);
  assert.equal(r.inventoryLabel(some), '2 of 4 items available');
  assert.equal(r.inventoryScore(some), ((1 + 1 + 0.5 + 0) / 4) * 100, 'half of a line counts as half');

  const none = r.inventoryMatch(cart, new Map());
  assert.equal(none.status, 'none');
  assert.equal(r.inventoryLabel(none), 'Out of stock for your order');
  assert.equal(r.inventoryScore(none), 0);
  assert.deepEqual(none.items.map((i) => i.available), [0, 0, 0, 0]);

  const noCart = r.inventoryMatch([], new Map());
  assert.equal(noCart.status, null);
  assert.equal(r.inventoryLabel(noCart), null);
  assert.equal(r.inventoryScore(noCart), r.NEUTRAL);
});

test('opening hours are judged in the center\'s time zone, not the server\'s', () => {
  const center = { isOpen: true, opensAt: '09:00', closesAt: '18:00' };
  const tz = 'Asia/Kolkata'; // UTC+5:30
  // 04:30 UTC = 10:00 in India
  const morning = r.hoursStatus(center, new Date('2026-09-23T04:30:00Z'), tz);
  assert.equal(morning.isOpenNow, true);
  assert.equal(morning.label, 'Open until 18:00');
  // The same instant is 04:30 in UTC: closed there.
  assert.equal(r.hoursStatus(center, new Date('2026-09-23T04:30:00Z'), 'UTC').isOpenNow, false);
  // 02:00 UTC = 07:30 in India
  const early = r.hoursStatus(center, new Date('2026-09-23T02:00:00Z'), tz);
  assert.equal(early.isOpenNow, false);
  assert.equal(early.label, 'Opens today at 09:00');
  assert.equal(early.minutesUntilOpen, 90);
  // 14:30 UTC = 20:00 in India
  const night = r.hoursStatus(center, new Date('2026-09-23T14:30:00Z'), tz);
  assert.equal(night.label, 'Opens tomorrow at 09:00');
  assert.equal(night.minutesUntilOpen, 13 * 60);
  // Closing time itself is closed; opening time itself is open.
  assert.equal(r.hoursStatus(center, new Date('2026-09-23T12:30:00Z'), tz).isOpenNow, false); // 18:00
  assert.equal(r.hoursStatus(center, new Date('2026-09-23T03:30:00Z'), tz).isOpenNow, true); // 09:00
  // Switched off by the operator wins over the hours.
  const off = r.hoursStatus({ ...center, isOpen: false }, new Date('2026-09-23T04:30:00Z'), tz);
  assert.equal(off.isOpenNow, false);
  assert.equal(off.label, 'Closed by operator');
});

test('operational score: open beats closed, a short queue beats a long one', () => {
  const at = (iso, over = {}) => r.hoursStatus({ isOpen: true, opensAt: '09:00', closesAt: '18:00', ...over }, new Date(iso), 'Asia/Kolkata');
  const open = at('2026-09-23T04:30:00Z');
  assert.equal(r.operationalScore(open, 0), 100);
  assert.equal(r.operationalScore(open, 25), 80);
  assert.equal(r.operationalScore(open, 50), 60);
  assert.equal(r.operationalScore(open, 500), 60, 'the queue penalty is capped');
  const opensSoon = at('2026-09-23T02:00:00Z'); // 90 minutes to opening
  assert.equal(r.operationalScore(opensSoon, 0), 70);
  const opensTomorrow = at('2026-09-23T14:30:00Z'); // 13 hours away: not a realistic visit
  assert.equal(r.operationalScore(opensTomorrow, 0), 40);
  const switchedOff = at('2026-09-23T04:30:00Z', { isOpen: false });
  assert.equal(r.operationalScore(switchedOff, 0), 40);
});

test('composite score uses the 40/35/15/10 weights; historical is neutral for now', () => {
  assert.equal(r.compositeScore({ distance: 100, inventory: 100, operational: 100, historical: 100 }), 100);
  near(r.compositeScore({ distance: 100, inventory: 0, operational: 0, historical: 0 }), 40, 1e-9);
  near(r.compositeScore({ distance: 0, inventory: 100, operational: 0, historical: 0 }), 35, 1e-9);
  near(r.compositeScore({ distance: 0, inventory: 0, operational: 100, historical: 0 }), 15, 1e-9);
  near(r.compositeScore({ distance: 0, inventory: 0, operational: 0, historical: 100 }), 10, 1e-9);
  assert.equal(r.historicalScore({ rating: 1, stockouts: 99 }), r.NEUTRAL);
  near(Object.values(r.WEIGHTS).reduce((a, b) => a + b, 0), 1, 1e-9);
});

test('home center gets a 20% bonus, capped at 100', () => {
  assert.equal(r.withHomeBonus(50, true), 60);
  assert.equal(r.withHomeBonus(50, false), 50);
  assert.equal(r.withHomeBonus(95, true), 100);
});

const card = (over) => ({ distanceKm: 5, scores: { total: 50 }, inventory: { status: 'all', availableItems: 2, totalItems: 2 }, hours: { isOpenNow: true }, isHomeCenter: false, ...over });

test('ordering: an empty shelf ranks below everything with stock, then by score, then by distance', () => {
  const emptyButClose = card({ id: 'empty', distanceKm: 1, scores: { total: 90 }, inventory: { status: 'none' } });
  const partial = card({ id: 'partial', distanceKm: 20, scores: { total: 40 }, inventory: { status: 'partial' } });
  const full = card({ id: 'full', distanceKm: 8, scores: { total: 70 } });
  const tieNear = card({ id: 'tieNear', distanceKm: 3, scores: { total: 40 } });
  const sorted = [emptyButClose, partial, full, tieNear].sort(r.compareCenters).map((c) => c.id);
  assert.deepEqual(sorted, ['full', 'tieNear', 'partial', 'empty']);
});

test('recommendation reasons read like a person wrote them', () => {
  const top = card({ distanceKm: 2.3 });
  assert.equal(r.recommendationReason(top, [top, card({ distanceKm: 9 })]), 'Closest center with all your items in stock');
  // Someone nearer has some stock, but this is the nearest with everything.
  const nearerPartial = card({ distanceKm: 1, inventory: { status: 'partial', availableItems: 1, totalItems: 2 } });
  assert.equal(r.recommendationReason(top, [top, nearerPartial]), 'Closest center with all your items in stock');
  // A closer center that also has everything exists: this one is just the best-scoring.
  const closerAll = card({ distanceKm: 1 });
  assert.equal(r.recommendationReason(card({ distanceKm: 6 }), [closerAll, card({ distanceKm: 6 })]), 'All your items in stock, 6 km away');
  assert.equal(r.recommendationReason(card({ distanceKm: 2, inventory: { status: 'partial', availableItems: 3, totalItems: 4 } }), [top]), '2 km away, 3 of 4 items available');
  assert.equal(r.recommendationReason(card({ distanceKm: 4, inventory: { status: 'none' } }), [top]), '4 km away, but none of your items are in stock right now');
  const noCart = card({ inventory: { status: null } });
  assert.equal(r.recommendationReason(noCart, [noCart]), 'Closest open center');
  assert.equal(r.recommendationReason(card({ inventory: { status: null }, hours: { isOpenNow: false } }), [card({ distanceKm: 1 })]), 'Best overall match, 5 km away');
  assert.equal(r.recommendationReason(card({ isHomeCenter: true }), [card()]), 'Your home center: Closest center with all your items in stock');
});

test('village lookup: name, name + district, case and spacing, unknowns', () => {
  assert.equal(findVillage('Shirur').district, 'Pune');
  assert.equal(findVillage('  shirur ,  PUNE ').name, 'Shirur');
  assert.equal(findVillage('Shirur, Nashik'), null, 'the district must agree');
  assert.equal(findVillage('Atlantis'), null);
  assert.equal(findVillage(''), null);
  assert.equal(findVillage(undefined), null);
  assert.ok(searchVillages('shir').some((v) => v.name === 'Shirur'));
  assert.ok(searchVillages('nashik').length >= 2, 'matches district too');
  assert.equal(searchVillages('', 5).length, 5);
});
