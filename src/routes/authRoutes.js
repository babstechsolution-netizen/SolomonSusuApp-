const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { JWT_SECRET, JWT_EXPIRES_IN } = require('../config/env');

const router = express.Router();

const signToken = (id) => jwt.sign({ id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required.' });

    const user = await User.findOne({ username: username.toLowerCase().trim() });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Account suspended. Contact admin.' });
    }

    user.lastLogin = new Date();
    await user.save({ validateModifiedOnly: true });

    res.json({ success: true, token: signToken(user._id), user: user.toPublic() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/auth/me
router.get('/me', protect, (req, res) => {
  res.json({ success: true, user: req.user });
});

// PATCH /api/auth/change-password
router.patch('/change-password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);
    if (!(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
    }
    user.password = newPassword;
    await user.save();
    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/auth/me  — update own profile (name, phone, username)
router.patch('/me', protect, async (req, res) => {
  try {
    const { name, phone, username } = req.body;
    const updates = {};
    if (name && name.trim()) updates.name = name.trim();
    if (phone !== undefined) updates.phone = phone;
    if (username && username.trim()) updates.username = username.toLowerCase().trim();
    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });
    res.json({ success: true, user: user.toPublic() });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/auth/seed-admin  (run once to create the first super admin)
router.post('/seed-admin', async (req, res) => {
  try {
    // If an existing Super Admin has no username yet, add it
    const existingAdmin = await User.findOne({ role: 'Super Admin' });
    if (existingAdmin && !existingAdmin.username) {
      existingAdmin.username = 'admin';
      await existingAdmin.save({ validateModifiedOnly: true });
      return res.json({ success: true, message: 'Admin updated with username.', user: existingAdmin.toPublic() });
    }
    if (existingAdmin) {
      return res.status(400).json({ success: false, message: 'Admin already exists.' });
    }

    const admin = await User.create({
      name: 'Super Admin',
      username: 'admin',
      password: 'admin123',
      role: 'Super Admin',
      roleKey: 'superadmin',
    });
    res.status(201).json({ success: true, message: 'Admin created.', user: admin.toPublic() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
