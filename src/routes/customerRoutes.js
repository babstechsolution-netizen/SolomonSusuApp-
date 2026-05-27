const express = require('express');
const Customer = require('../models/Customer');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

// GET /api/customers
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.employee) filter.assignedEmployee = req.query.employee;
    if (req.query.status) filter.status = req.query.status;
    const customers = await Customer.find(filter).populate('assignedEmployee', 'name zone phone').sort({ createdAt: -1 });
    res.json({ success: true, data: customers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/customers/:id
router.get('/:id', async (req, res) => {
  try {
    const cust = await Customer.findById(req.params.id).populate('assignedEmployee', 'name zone');
    if (!cust) return res.status(404).json({ success: false, message: 'Customer not found.' });
    res.json({ success: true, data: cust });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/customers/qr/:code
router.get('/qr/:code', async (req, res) => {
  try {
    const cust = await Customer.findOne({ qrCode: req.params.code }).populate('assignedEmployee', 'name');
    if (!cust) return res.status(404).json({ success: false, message: 'Customer not found for QR code.' });
    res.json({ success: true, data: cust });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/customers
router.post('/', requireRole('Super Admin', 'Branch Manager', 'Field Collector'), async (req, res) => {
  try {
    const cust = await Customer.create(req.body);
    res.status(201).json({ success: true, data: cust });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/customers/:id
router.patch('/:id', async (req, res) => {
  try {
    const cust = await Customer.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!cust) return res.status(404).json({ success: false, message: 'Customer not found.' });
    res.json({ success: true, data: cust });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/customers  — wipe all (Super Admin only)
router.delete('/', requireRole('Super Admin'), async (req, res) => {
  try {
    await Customer.deleteMany({});
    res.json({ success: true, message: 'All customers deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/customers/:id/assign
router.patch('/:id/assign', requireRole('Super Admin', 'Branch Manager'), async (req, res) => {
  try {
    const { employeeId } = req.body;
    const cust = await Customer.findByIdAndUpdate(req.params.id, { assignedEmployee: employeeId }, { new: true }).populate('assignedEmployee', 'name');
    res.json({ success: true, data: cust, message: 'Customer reassigned.' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
