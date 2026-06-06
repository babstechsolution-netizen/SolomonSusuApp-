const mongoose = require('mongoose');

const backupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  data: { type: String, required: true },
  sizeBytes: { type: Number, default: 0 },
  recordCounts: { type: Object, default: {} },
  type: { type: String, enum: ['manual', 'scheduled'], default: 'manual' },
  createdBy: { type: String, default: 'system' },
}, { timestamps: true });

module.exports = mongoose.model('Backup', backupSchema);
