const mongoose = require('mongoose');
const { MONGODB_URI } = require('../config/env');

const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('MongoDB connected successfully');
    await fixEmailIndex();
    await ensureDefaultAdmin();
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  }
};

// The email field has sparse:true in the schema, but if the index was created
// before sparse was set, MongoDB won't allow multiple null emails.
// Drop the non-sparse index so Mongoose recreates it correctly on next start.
async function fixEmailIndex() {
  try {
    const col = mongoose.connection.collection('users');
    const indexes = await col.indexes();
    const emailIdx = indexes.find(i => i.name === 'email_1');
    if (emailIdx && !emailIdx.sparse) {
      await col.dropIndex('email_1');
      console.log('Dropped non-sparse email index — Mongoose will recreate it as sparse');
    }
  } catch (e) {
    // Ignore — index may not exist yet
  }
}

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
