const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  customerName: { type: String },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  employeeName: { type: String },
  amount: { type: Number, required: true, min: 0.01 },
  type: { type: String, enum: ['deposit', 'withdrawal'], required: true },
  method: { type: String, enum: ['Cash', 'MoMo', 'Bank Transfer'], default: 'Cash' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved' },
  notes: { type: String },
  feePercent: { type: Number, default: 0 },
  feeAmount: { type: Number, default: 0 },
  receiptNumber: { type: String, unique: true },
  // De-duplication key for offline retries: a queued transaction re-sent with the same key
  // returns the original record instead of being recorded twice.
  idempotencyKey: { type: String, unique: true, sparse: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  date: { type: String },
  time: { type: String },
}, { timestamps: true });

// Indexes for dashboards, approvals, collector summaries and history queries
transactionSchema.index({ type: 1, status: 1, date: 1 });
transactionSchema.index({ employee: 1, date: 1 });
transactionSchema.index({ customer: 1, createdAt: -1 });
transactionSchema.index({ status: 1, createdAt: -1 });

transactionSchema.pre('save', function (next) {
  if (!this.receiptNumber) {
    // Human-readable receipt reference, e.g. AW-TXN-260706-482913
    const d = new Date();
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    this.receiptNumber = `AW-TXN-${yy}${mm}${dd}-${String(Date.now()).slice(-6)}`;
  }
  if (!this.date) {
    this.date = new Date().toISOString().split('T')[0];
  }
  if (!this.time) {
    this.time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }
  next();
});

module.exports = mongoose.model('Transaction', transactionSchema);
