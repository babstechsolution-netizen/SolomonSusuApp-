const Notification = require('../models/Notification');
const { notify: emit } = require('../socket');

// Persist a notification AND push it in real time. Persisting means any device can later
// load the same history via GET /api/notifications; emitting keeps online devices instant.
// Notifying must never crash the main request, so everything is wrapped.
async function createNotification({ recipientUser, recipientRole, type, title, body, amount, customer }) {
  try {
    const doc = await Notification.create({ recipientUser, recipientRole, type, title, body, amount, customer });
    emit({
      id: doc._id,
      recipientUser: recipientUser || null,
      recipientRole: recipientRole || null,
      type: doc.type,
      title: doc.title,
      message: doc.body,
      amount: doc.amount,
      customer: doc.customer,
      time: doc.createdAt,
    });
    return doc;
  } catch (e) {
    console.error('[notify]', e.message);
    return null;
  }
}

module.exports = { createNotification };
