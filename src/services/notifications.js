const crypto = require('crypto');

const MAX_PER_OWNER = 100;

// Adds an in-app notification. `q` is the pool or a transaction client, so a
// notification commits (or rolls back) together with the change that caused
// it. A missing owner (walk-in / seeded orders) is silently skipped.
const notify = async (q, ownerId, { type, title, body, refId = null }) => {
  if (!ownerId) return;
  await q.query(
    'INSERT INTO notifications (id, owner_id, type, title, body, ref_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [`notif-${crypto.randomUUID()}`, ownerId, type, title, body, refId],
  );
  // Keep only the newest MAX_PER_OWNER.
  await q.query(
    `DELETE FROM notifications WHERE owner_id = $1 AND id NOT IN (
       SELECT id FROM notifications WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2)`,
    [ownerId, MAX_PER_OWNER],
  );
};

const unreadCount = async (q, ownerId) =>
  (await q.query('SELECT count(*)::int AS n FROM notifications WHERE owner_id = $1 AND NOT read', [ownerId])).rows[0].n;

const NOTIFICATION_COLUMNS = 'id, type, title, body, ref_id AS "refId", created_at AS "createdAt", read';

module.exports = { notify, unreadCount, NOTIFICATION_COLUMNS };
