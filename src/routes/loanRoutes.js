const express = require('express');
const Loan = require('../models/Loan');
const Customer = require('../models/Customer');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

// GET /api/loans
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.customer) filter.customer = req.query.customer;
    const loans = await Loan.find(filter).populate('customer', 'name phone').sort({ createdAt: -1 });
    res.json({ success: true, data: loans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/loans  — wipe all (Super Admin only)
router.delete('/', requireRole('Super Admin'), async (req, res) => {
  try {
    await Loan.deleteMany({});
    res.json({ success: true, message: 'All loans deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/loans
router.post('/', requireRole('Super Admin', 'Branch Manager'), async (req, res) => {
  try {
    const customer = await Customer.findById(req.body.customer);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });
    const loan = await Loan.create({
      ...req.body,
      customerName: customer.name,
      approvedBy: req.user._id,
      officer: req.user.name,
    });
    res.status(201).json({ success: true, data: loan });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/loans/:id
router.patch('/:id', requireRole('Super Admin', 'Branch Manager', 'Accountant'), async (req, res) => {
  try {
    const loan = await Loan.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!loan) return res.status(404).json({ success: false, message: 'Loan not found.' });
    res.json({ success: true, data: loan });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/loans/:id/repay
router.post('/:id/repay', async (req, res) => {
  try {
    const { amount } = req.body;
    const loan = await Loan.findById(req.params.id);
    if (!loan) return res.status(404).json({ success: false, message: 'Loan not found.' });
    loan.outstanding = Math.max(0, loan.outstanding - Number(amount));
    if (loan.outstanding === 0) loan.status = 'completed';
    await loan.save();
    res.json({ success: true, data: loan, message: 'Repayment recorded.' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
