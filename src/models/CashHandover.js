const mongoose = require('mongoose');

// Daily cash reconciliation: the manager counts the physical cash a field collector hands
// over and confirms it matches what the collector recorded in the system that day. Until
// this is reconciled, that day's cash deposits stay excluded from company-wide totals
// (dashboard, reports) even though each customer's own balance already reflects them.
const cashHandoverSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  employeeName: { type: String },
  date: { type: String, required: true }, // YYYY-MM-DD
  systemTotal: { type: Number, required: true },
  cashReceived: { type: Number, required: true },
  variance: { type: Number, required: true }, // cashReceived - systemTotal
  status: { type: String, enum: ['reconciled', 'flagged'], required: true },
  notes: { type: String },
  reconciledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reconciledByName: { type: String },
  transactionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' }],
}, { timestamps: true });

// One handover per collector per day — resubmitting updates the same record.
cashHandoverSchema.index({ employee: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('CashHandover', cashHandoverSchema);
