const crypto = require('crypto');
const { HttpError } = require('../utils/http');

const totalOf = (order) => order.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);

// The pickup OTP is the farmer's secret: only the farmer-facing endpoints
// reveal it. The operator app types in what the farmer reads out and the
// server does the comparison, so the operator API never returns it.
const serializeOrder = (order, { includeOtp }) => {
  const { deviceId, ...rest } = order;
  return {
    ...rest,
    pickupOtp: includeOtp ? order.pickupOtp : null,
    totalAmount: totalOf(order),
    itemCount: order.items.reduce((sum, i) => sum + i.quantity, 0),
  };
};

const newOrderId = () => `order-${crypto.randomUUID()}`;
const newOtp = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

const findOrder = (store, id) => {
  const order = store.data.orders.find((o) => o.id === id);
  if (!order) throw new HttpError(404, 'Order not found');
  return order;
};

// `onCancelled` runs just before the save so any side effect (a notification)
// is persisted in the same write as the status change.
const cancelOrder = (store, order, onCancelled) => {
  if (order.status !== 'pending' && order.status !== 'readyForPickup') {
    throw new HttpError(409, `A ${order.status} order cannot be cancelled`);
  }
  order.status = 'cancelled';
  order.pickupOtp = null;
  if (onCancelled) onCancelled();
  store.save();
};

module.exports = { serializeOrder, newOrderId, newOtp, findOrder, cancelOrder };
