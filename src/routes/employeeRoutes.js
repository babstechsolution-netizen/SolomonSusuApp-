const express = require('express');
const Employee = require('../models/Employee');
const User = require('../models/User');
const { protect, requireRole } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');

const router = express.Router();
router.use(protect);

const ROLE_MAP = {
  field_collector: 'Field Collector',
  branch_manager: 'Branch Manager',
  team_lead: 'Field Collector',
};


// GET /api/employees
router.get('/', async (req, res) => {
  try {
    const employees = await Employee.find().sort({ createdAt: -1 });
    res.json({ success: true, data: employees });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/employees/:id
router.get('/:id', async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });
    res.json({ success: true, data: emp });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/employees
router.post('/', requireRole('Super Admin', 'Branch Manager'), async (req, res) => {
  try {
    const { name, phone, zone, role, privileges, color, photo, email, username, password } = req.body;

    if (!username || !username.trim()) {
      return res.status(400).json({ success: false, message: 'Username is required.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const cleanUsername = username.toLowerCase().trim();
    const existing = await User.findOne({ username: cleanUsername });
    if (existing) {
      return res.status(400).json({ success: false, message: `Username "${cleanUsername}" is already taken.` });
    }

    const userRole = ROLE_MAP[role] || 'Field Collector';

    const user = await User.create({
      name,
      username: cleanUsername,
      password,
      role: userRole,
      phone,
      zone,
      ...(email ? { email } : {}),
    });

    const emp = await Employee.create({
      name, phone, zone, role, privileges, color, photo,
      ...(email ? { email } : {}),
      userId: user._id,
    });

    logActivity('employee_add', req.user.name, req.user.role, `${req.user.name} added employee ${name} (${userRole})`, { employee: name, role: userRole });
    res.status(201).json({
      success: true,
      data: emp,
      credentials: { username: cleanUsername, password },
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/employees/:id/credentials — change login username/password
router.patch('/:id/credentials', requireRole('Super Admin', 'Branch Manager'), async (req, res) => {
  try {
    const { username, password } = req.body;
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });
    if (!emp.userId) return res.status(400).json({ success: false, message: 'No linked user account for this employee.' });

    const updates = {};
    if (username && username.trim()) {
      const clean = username.toLowerCase().trim();
      const clash = await User.findOne({ username: clean, _id: { $ne: emp.userId } });
      if (clash) return res.status(400).json({ success: false, message: `Username "${clean}" is already taken.` });
      updates.username = clean;
    }
    if (password) {
      if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
      updates.password = password;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, message: 'Provide a username or password to update.' });

    const user = await User.findById(emp.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User account not found.' });
    Object.assign(user, updates);
    await user.save();
    logActivity('credential_change', req.user.name, req.user.role, `${req.user.name} updated login credentials for employee ${emp.name}`, { employee: emp.name });
    res.json({ success: true, message: 'Credentials updated successfully.' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/employees/:id
router.patch('/:id', requireRole('Super Admin', 'Branch Manager'), async (req, res) => {
  try {
    const emp = await Employee.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });
    res.json({ success: true, data: emp });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/employees/:id/status
router.patch('/:id/status', requireRole('Super Admin', 'Branch Manager'), async (req, res) => {
  try {
    const { status } = req.body;
    const emp = await Employee.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });
    logActivity('employee_status', req.user.name, req.user.role, `${req.user.name} ${status} employee ${emp.name}`, { employee: emp.name, status });
    res.json({ success: true, data: emp, message: `Employee ${status}.` });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/employees  — wipe all (Super Admin only)
router.delete('/', requireRole('Super Admin'), async (req, res) => {
  try {
    await Employee.deleteMany({});
    res.json({ success: true, message: 'All employees deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/employees/:id
router.delete('/:id', requireRole('Super Admin'), async (req, res) => {
  try {
    const emp = await Employee.findByIdAndDelete(req.params.id);
    if (emp) logActivity('employee_delete', req.user.name, req.user.role, `${req.user.name} deleted employee ${emp.name}`, { employee: emp ? emp.name : req.params.id });
    res.json({ success: true, message: 'Employee deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
