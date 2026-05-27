const express = require('express');
const Transaction = require('../models/Transaction');
const Customer = require('../models/Customer');
const Employee = require('../models/Employee');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

// GET /api/transactions
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.type) filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.method) filter.method = req.query.method;
    if (req.query.employee) filter.employee = req.query.employee;
    if (req.query.customer) filter.customer = req.query.customer;
    if (req.query.date) filter.date = req.query.date;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      Transaction.find(filter)
        .populate('customer', 'name phone')
        .populate('employee', 'name zone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Transaction.countDocuments(filter),
    ]);

    res.json({ success: true, data, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/transactions  (deposit or withdrawal)
router.post('/', async (req, res) => {
  try {
    const { customerId, amount, type, method, notes } = req.body;
    if (!customerId || !amount || !type) {
      return res.status(400).json({ success: false, message: 'customerId, amount and type are required.' });
    }

    const customer = await Customer.findById(customerId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

    const employee = await Employee.findOne({ userId: req.user._id });

    if (type === 'withdrawal' && amount > customer.balance) {
      return res.status(400).json({ success: false, message: 'Insufficient balance.' });
    }

    const tx = await Transaction.create({
      customer: customer._id,
      customerName: customer.name,
      employee: employee ? employee._id : null,
      employeeName: req.user.name,
      amount: Number(amount),
      type,
      method: method || 'Cash',
      status: 'approved',
      notes,
    });

    // Update customer balance and totals
    if (type === 'deposit') {
      customer.balance += Number(amount);
      customer.totalDeposits += Number(amount);
    } else {
      customer.balance -= Number(amount);
      customer.totalWithdrawals += Number(amount);
    }
    await customer.save();

    // Update employee stats
    if (employee) {
      if (type === 'deposit') employee.collections += Number(amount);
      else employee.withdrawals += Number(amount);
      await employee.save();
    }

    res.status(201).json({ success: true, data: tx });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/transactions/:id/status
router.patch('/:id/status', requireRole('Super Admin', 'Branch Manager', 'Accountant'), async (req, res) => {
  try {
    const { status } = req.body;
    const tx = await Transaction.findByIdAndUpdate(
      req.params.id,
      { status, approvedBy: req.user._id },
      { new: true }
    );
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found.' });
    res.json({ success: true, data: tx });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/transactions  — wipe all (Super Admin only)
router.delete('/', requireRole('Super Admin'), async (req, res) => {
  try {
    await Transaction.deleteMany({});
    res.json({ success: true, message: 'All transactions deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/transactions/summary
router.get('/summary', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [todayDeposits, todayWithdrawals, allDeposits, allWithdrawals, byMethod] = await Promise.all([
      Transaction.aggregate([{ $match: { type: 'deposit', status: 'approved', date: today } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Transaction.aggregate([{ $match: { type: 'withdrawal', status: 'approved', date: today } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Transaction.aggregate([{ $match: { type: 'deposit', status: 'approved' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Transaction.aggregate([{ $match: { type: 'withdrawal', status: 'approved' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Transaction.aggregate([{ $group: { _id: '$method', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
    ]);
    res.json({
      success: true,
      data: {
        todayDeposits: todayDeposits[0] || { total: 0, count: 0 },
        todayWithdrawals: todayWithdrawals[0] || { total: 0, count: 0 },
        totalDeposits: (allDeposits[0] || {}).total || 0,
        totalWithdrawals: (allWithdrawals[0] || {}).total || 0,
        byMethod,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
