const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  type: { type: String, required: true },   // login, logout, deposit, withdrawal, employee_add, employee_delete, customer_add, customer_delete, backup, restore, credential_change
  actor: { type: String, required: true },  // name of the user who did it
  actorRole: { type: String, default: '' },
  action: { type: String, required: true }, // human-readable description
  details: { type: Object, default: {} },   // extra context (amount, customer name, etc.)
}, { timestamps: true });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
