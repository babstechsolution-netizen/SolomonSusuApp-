const mongoose = require('mongoose');

const loanSchema = new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  customerName: { type: String },
  amount: { type: Number, required: true, min: 1 },
  outstanding: { type: Number },
  interestRate: { type: Number, default: 5 },
  purpose: { type: String },
  status: { type: String, enum: ['active', 'overdue', 'completed'], default: 'active' },
  disbursedDate: { type: String },
  dueDate: { type: String },
  officer: { type: String },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

loanSchema.pre('save', function (next) {
  if (this.outstanding === undefined) this.outstanding = this.amount;
  if (!this.disbursedDate) this.disbursedDate = new Date().toISOString().split('T')[0];
  next();
});

module.exports = mongoose.model('Loan', loanSchema);
