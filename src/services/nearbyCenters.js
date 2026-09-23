const { haversineKm, boundingBox, estimateTravelMinutes } = require('./geo');
const ranking = require('./centerRanking');
const { SERVICEABLE } = require('./centerService');

const WIDEST_KM = ranking.RADII_KM[ranking.RADII_KM.length - 1];

// Finds and ranks the centers a farmer could use.
//   origin        {latitude, longitude}
//   items         [{productId, quantity}] — the cart / recommendation list (may be empty)
//   homeCenterId  the farmer's usual center, if any (gets a score bonus)
// Only active centers that have an operator can serve anyone, so only those
// are considered.
const findNearby = async (db, { origin, items = [], homeCenterId = null, limit = 5, now = new Date(), timeZone }) => {
  const box = boundingBox(origin, WIDEST_KM);
  const { rows: candidates } = await db.query(
    `SELECT c.center_id AS "centerId", c.name, c.village, c.district, c.latitude, c.longitude,
            c.operator_name AS "operatorName", c.phone, c.is_open AS "isOpen",
            to_char(c.opens_at, 'HH24:MI') AS "opensAt", to_char(c.closes_at, 'HH24:MI') AS "closesAt"
       FROM village_center c
      WHERE ${SERVICEABLE}
        AND c.latitude BETWEEN $1 AND $2 AND c.longitude BETWEEN $3 AND $4`,
    [box.minLat, box.maxLat, box.minLng, box.maxLng],
  );

  const measured = candidates
    .map((c) => ({ ...c, rawKm: haversineKm(origin, c) }))
    .filter((c) => c.rawKm <= WIDEST_KM);
  const radiusKm = ranking.pickRadius(measured.map((c) => c.rawKm));
  const inRange = measured.filter((c) => c.rawKm <= radiusKm);
  if (!inRange.length) return { radiusKm, centers: [] };

  const ids = inRange.map((c) => c.centerId);

  // Available = on hand minus reserved: stock already promised to another
  // farmer's pending order can't be promised again.
  const available = new Map(ids.map((id) => [id, new Map()]));
  if (items.length) {
    const { rows } = await db.query(
      `SELECT center_id, product_id, (on_hand - reserved) AS available
         FROM center_inventory WHERE center_id = ANY($1) AND product_id = ANY($2)`,
      [ids, items.map((i) => i.productId)],
    );
    for (const r of rows) available.get(r.center_id).set(r.product_id, r.available);
  }

  const { rows: pending } = await db.query(
    `SELECT center_id, count(*)::int AS n FROM orders
      WHERE center_id = ANY($1) AND status IN ('pending','readyForPickup') GROUP BY center_id`,
    [ids],
  );
  const pendingBy = new Map(pending.map((p) => [p.center_id, p.n]));

  const scored = inRange.map((c) => {
    const distanceKm = ranking.round1(c.rawKm);
    const inventory = ranking.inventoryMatch(items, available.get(c.centerId));
    const hours = ranking.hoursStatus(c, now, timeZone);
    const pendingPickups = pendingBy.get(c.centerId) || 0;
    const parts = {
      distance: ranking.distanceScore(c.rawKm),
      inventory: ranking.inventoryScore(inventory),
      operational: ranking.operationalScore(hours, pendingPickups),
      historical: ranking.historicalScore(),
    };
    const isHomeCenter = c.centerId === homeCenterId;
    const total = ranking.withHomeBonus(ranking.compositeScore(parts), isHomeCenter);
    return {
      center: {
        centerId: c.centerId, name: c.name, village: c.village, district: c.district,
        latitude: c.latitude, longitude: c.longitude, operatorName: c.operatorName, phone: c.phone,
        rating: null, // no ratings are collected yet
      },
      distanceKm,
      estimatedTravelMinutes: estimateTravelMinutes(c.rawKm),
      travelTimeIsEstimate: true,
      inventory: { status: inventory.status, label: ranking.inventoryLabel(inventory), availableItems: inventory.availableItems, totalItems: inventory.totalItems, items: inventory.items },
      hours,
      pendingPickups,
      scores: {
        distance: ranking.round1(parts.distance), inventory: ranking.round1(parts.inventory),
        operational: ranking.round1(parts.operational), historical: ranking.round1(parts.historical),
        total: ranking.round1(total),
      },
      isHomeCenter,
    };
  });

  scored.sort(ranking.compareCenters);
  const centers = scored.slice(0, limit).map((c, i) => ({ ...c, isRecommended: i === 0 }));
  centers[0].recommendationReason = ranking.recommendationReason(centers[0], scored);
  return { radiusKm, centers };
};

module.exports = { findNearby };
