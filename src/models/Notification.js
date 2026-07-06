const mongoose = require('mongoose');

// A stored, retrievable notification so every device shows the same alert history.
// Targeting: set recipientUser for a specific person, and/or recipientRole to reach a whole
// role (e.g. all admins). A notification with neither is treated as a broadcast to everyone.
const notificationSchema = new mongoose.Schema({
  recipientUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  recipientRole: { type: String },
  type: { type: String, default: 'info' }, // deposit | withdrawal | approval | info | milestone
  title: { type: String },
  body: { type: String },
  amount: { type: Number },
  customer: { type: String },
  read: { type: Boolean, default: false },
}, { timestamps: true });

// Fast lookups for "my notifications"
notificationSchema.index({ recipientUser: 1, createdAt: -1 });
notificationSchema.index({ recipientRole: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
