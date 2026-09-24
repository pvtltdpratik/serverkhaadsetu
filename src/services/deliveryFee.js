const config = require('../config');

// The pure rules of pricing and timing a delivery. No database in here, so the
// numbers a farmer is quoted can be checked by hand.

// Roads are longer than the straight line between two villages.
const ROAD_FACTOR = 1.3;

const roadKm = (straightKm) => Math.round(straightKm * ROAD_FACTOR * 10) / 10;

// fee = base + per km (by road) + per 10 kg above the first 10, rounded UP to the
// next Rs 5 and never below the minimum. There is no bargaining: the app fixes it.
//   40 kg over 5 km in a straight line (6.5 km by road): 25 + 4 x 6.5 + 2 x 3 = 57 -> Rs 60
const computeFee = ({ roadKm: km, weightKg }, rules = config.delivery) => {
  const extraTens = Math.max(0, Math.ceil((weightKg - 10) / 10));
  const raw = rules.baseFee + rules.perKm * km + rules.per10Kg * extraTens;
  return Math.max(rules.minFee, Math.ceil(raw / 5) * 5);
};

// Which kind of vehicle a load is naturally for: a bike for small bags, a pickup
// for medium loads and a tractor for big ones. Matching partners uses their
// declared capacity, this is what the buyer is told.
const suggestVehicle = (weightKg) => (weightKg <= 30 ? 'bike' : weightKg <= 500 ? 'pickup' : 'tractor');

// Typical speed on village roads, used only for "about N minutes".
const SPEED_KMH = { bike: 30, pickup: 35, tractor: 18 };
const etaMinutes = (km, vehicleType) => Math.max(1, Math.ceil((km / (SPEED_KMH[vehicleType] || 25)) * 60));

module.exports = { ROAD_FACTOR, roadKm, computeFee, suggestVehicle, etaMinutes };
