const express = require('express');
const Employee = require('../models/Employee');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

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
    const emp = await Employee.create(req.body);
    res.status(201).json({ success: true, data: emp });
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
    await Employee.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Employee deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
