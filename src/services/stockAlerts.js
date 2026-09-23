const { notify } = require('./notifications');

// Low-stock alerting. "Low" means AVAILABLE stock (on hand minus reserved) at or
// under the reorder level: stock already promised to an app order is not
// really on the shelf.

// After something reduced availability: alerts the operator about every listed
// product that has just become low and has not been alerted since it last
// recovered. Stamps `low_stock_alerted_at` so each dip alerts exactly once.
// `q` is the pool or a transaction client (so the alert commits with the sale).
const checkLowStock = async (q, centerId, productIds) => {
  if (!productIds.length) return;
  const { rows } = await q.query(
    `UPDATE center_inventory ci SET low_stock_alerted_at = now()
       FROM products p, village_center c
      WHERE ci.center_id = $1 AND ci.product_id = ANY($2)
        AND p.id = ci.product_id AND c.center_id = ci.center_id
        AND ci.on_hand - ci.reserved <= ci.reorder_level
        AND ci.low_stock_alerted_at IS NULL
      RETURNING ci.product_id AS "productId", p.name, ci.on_hand - ci.reserved AS available,
                ci.reorder_level AS "reorderLevel", c.operator_id AS "operatorId"`,
    [centerId, productIds],
  );
  for (const r of rows) {
    if (!r.operatorId) continue;
    await notify(q, r.operatorId, {
      type: 'stock',
      title: r.available <= 0 ? `Out of stock: ${r.name}` : `Low stock: ${r.name}`,
      body: r.available <= 0
        ? `${r.name} has run out. Request a restock so farmers can order it again.`
        : `Only ${r.available} left to sell (reorder level ${r.reorderLevel}). Request a restock.`,
      refId: r.productId,
    });
  }
};

// After availability went up (restock, a released reservation, a lower reorder
// level): a product that is no longer low can alert again the next time it dips.
const rearmLowStock = async (q, centerId, productIds) => {
  if (!productIds.length) return;
  await q.query(
    `UPDATE center_inventory SET low_stock_alerted_at = NULL
      WHERE center_id = $1 AND product_id = ANY($2)
        AND low_stock_alerted_at IS NOT NULL AND on_hand - reserved > reorder_level`,
    [centerId, productIds],
  );
};

module.exports = { checkLowStock, rearmLowStock };
