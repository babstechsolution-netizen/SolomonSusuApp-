const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 6 },
  role: {
    type: String,
    enum: ['Super Admin', 'Branch Manager', 'Field Collector', 'Customer', 'Accountant'],
    default: 'Field Collector',
  },
  roleKey: { type: String },
  phone: { type: String },
  zone: { type: String },
  status: { type: String, enum: ['active', 'suspended', 'inactive'], default: 'active' },
  photo: { type: String },
  employeeId: { type: Number },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  lastLogin: { type: Date },
  // Appearance/preferences stored on the account so they follow the user to any device
  preferences: {
    darkMode: { type: Boolean, default: false },
    accentColor: { type: String, default: '#1A5C2E' },
    textSize: { type: String, default: 'medium' },
  },
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = async function (plainPassword) {
  return bcrypt.compare(plainPassword, this.password);
};

userSchema.methods.toPublic = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
