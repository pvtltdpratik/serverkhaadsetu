const crypto = require('crypto');

const MAX_PER_DEVICE = 100;

// Adds an in-app notification for a device. Does not save — callers already
// persist right after the change that triggered it, so both land in one write.
// A missing device id (walk-in / seeded orders) is silently skipped.
const notify = (store, deviceId, { type, title, body, refId = null }) => {
  if (!deviceId) return;
  const all = store.data.notifications;
  all.push({
    id: `notif-${crypto.randomUUID()}`,
    deviceId,
    type,
    title,
    body,
    refId,
    createdAt: new Date().toISOString(),
    read: false,
  });

  const mine = all.filter((n) => n.deviceId === deviceId);
  if (mine.length > MAX_PER_DEVICE) {
    const drop = new Set(
      mine
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, mine.length - MAX_PER_DEVICE)
        .map((n) => n.id),
    );
    store.data.notifications = all.filter((n) => !drop.has(n.id));
  }
};

const unreadCount = (store, deviceId) =>
  store.data.notifications.filter((n) => n.deviceId === deviceId && !n.read).length;

const serializeNotification = ({ deviceId, ...rest }) => rest;

module.exports = { notify, unreadCount, serializeNotification };
