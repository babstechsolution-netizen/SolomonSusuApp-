const mongoose = require('mongoose');
const { MONGODB_URI } = require('../config/env');

const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('MongoDB connected successfully');
    await ensureDefaultAdmin();
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  }
};

async function ensureDefaultAdmin() {
  try {
    const User = require('../models/User');

    // Fix any existing Super Admin that has no username yet
    await User.updateMany(
      { role: 'Super Admin', username: { $exists: false } },
      { $set: { username: 'admin' } }
    );

    // Create default admin if none exists at all
    const exists = await User.findOne({ role: 'Super Admin' });
    if (!exists) {
      await User.create({
        name: 'Super Admin',
        username: 'admin',
        password: 'admin123',
        role: 'Super Admin',
        roleKey: 'superadmin',
      });
      console.log('Default admin created — username: admin, password: admin123');
    }
  } catch (err) {
    console.error('Admin init error:', err.message);
  }
}

module.exports = connectDB;
