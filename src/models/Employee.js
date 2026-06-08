const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, lowercase: true, trim: true },
  phone: { type: String, required: true },
  zone: { type: String, required: true },
  status: { type: String, enum: ['active', 'suspended', 'inactive'], default: 'active' },
  role: { type: String, default: 'field_collector' },
  privileges: [{ type: String }],
  collections: { type: Number, default: 0 },
  withdrawals: { type: Number, default: 0 },
  performance: { type: Number, default: 80, min: 0, max: 100 },
  color: { type: String, default: '#16a34a' },
  photo: { type: String },
  nationalId: { type: String },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

employeeSchema.virtual('customerCount', {
  ref: 'Customer',
  localField: '_id',
  foreignField: 'assignedEmployee',
  count: true,
});

module.exports = mongoose.model('Employee', employeeSchema);
