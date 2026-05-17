const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  customerName: { type: String },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  employeeName: { type: String },
  amount: { type: Number, required: true, min: 0.01 },
  type: { type: String, enum: ['deposit', 'withdrawal'], required: true },
  method: { type: String, enum: ['Cash', 'MoMo', 'Bank Transfer'], default: 'Cash' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved' },
  notes: { type: String },
  receiptNumber: { type: String, unique: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  date: { type: String },
  time: { type: String },
}, { timestamps: true });

transactionSchema.pre('save', function (next) {
  if (!this.receiptNumber) {
    this.receiptNumber = 'RCP-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
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
