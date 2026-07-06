const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true },
  business: { type: String },
  location: { type: String },
  status: {
    type: String,
    enum: ['active', 'inactive', 'defaulting', 'completed'],
    default: 'active',
  },
  balance: { type: Number, default: 0 },
  totalDeposits: { type: Number, default: 0 },
  totalWithdrawals: { type: Number, default: 0 },
  savingsTarget: { type: Number, default: 10000 },
  dailyAmount: { type: Number, default: 50 },
  startDate: { type: String },
  color: { type: String, default: '#16a34a' },
  photo: { type: String },
  nationalId: { type: String },
  assignedEmployee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  qrCode: { type: String, unique: true, sparse: true },
}, { timestamps: true });

// Indexes for the most common lookups (collector's customers, status filters)
customerSchema.index({ assignedEmployee: 1 });
customerSchema.index({ status: 1 });

customerSchema.pre('save', function (next) {
  if (!this.qrCode) {
    this.qrCode = 'AW-' + String(Date.now()).slice(-6);
  }
  next();
});

module.exports = mongoose.model('Customer', customerSchema);
