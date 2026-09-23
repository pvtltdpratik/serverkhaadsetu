const crypto = require('crypto');
const { deviceId } = require('../utils/http');

// Records an administrator's action. `q` is the pool or a transaction client,
// so the record commits (or rolls back) together with the change itself.
const recordAudit = async (q, req, { action, targetType, targetId, details = {} }) => {
  await q.query(
    'INSERT INTO admin_audit (id, admin_id, admin_email, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [`audit-${crypto.randomUUID()}`, deviceId(req), req.userEmail || '', action, targetType, targetId, JSON.stringify(details)],
  );
};

module.exports = { recordAudit };
