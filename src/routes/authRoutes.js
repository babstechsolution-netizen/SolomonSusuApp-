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
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required.' });

    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
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

// PATCH /api/auth/me  — update own profile (name, phone)
router.patch('/me', protect, async (req, res) => {
  try {
    const { name, phone } = req.body;
    const updates = {};
    if (name && name.trim()) updates.name = name.trim();
    if (phone !== undefined) updates.phone = phone;
    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });
    res.json({ success: true, user: user.toPublic() });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/auth/seed-admin  (run once to create the first super admin)
router.post('/seed-admin', async (req, res) => {
  try {
    const exists = await User.findOne({ role: 'Super Admin' });
    if (exists) return res.status(400).json({ success: false, message: 'Admin already exists.' });

    const admin = await User.create({
      name: 'Super Admin',
      email: 'admin@awinbire.gh',
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
