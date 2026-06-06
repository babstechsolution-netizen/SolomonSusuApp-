const express = require('express');
const Transaction = require('../models/Transaction');
const Customer = require('../models/Customer');
const Employee = require('../models/Employee');
const { protect, requireRole } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');

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
    if (req.query.date) filter.date = req.query.date;
    // Customers can only see their own transactions
    if (req.user.role === 'Customer') {
      filter.customer = req.user.customerId;
    } else if (req.query.customer) {
      filter.customer = req.query.customer;
    }

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

// POST /api/transactions  (deposit or withdrawal; customers create pending withdrawal requests)
router.post('/', async (req, res) => {
  try {
    const isCustomer = req.user.role === 'Customer';
    const { amount, type, method, notes } = req.body;
    // Customers submit withdrawal requests for their own account; others specify customerId
    const customerId = isCustomer ? req.user.customerId : req.body.customerId;

    if (!customerId || !amount || !type) {
      return res.status(400).json({ success: false, message: 'customerId, amount and type are required.' });
    }
    if (isCustomer && type !== 'withdrawal') {
      return res.status(400).json({ success: false, message: 'Customers can only request withdrawals.' });
    }

    const customer = await Customer.findById(customerId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

    const employee = isCustomer ? null : await Employee.findOne({ userId: req.user._id });
    const txStatus = isCustomer ? 'pending' : 'approved';

    if (type === 'withdrawal' && txStatus === 'approved' && Number(amount) > customer.balance) {
      return res.status(400).json({ success: false, message: 'Insufficient balance.' });
    }

    const tx = await Transaction.create({
      customer: customer._id,
      customerName: customer.name,
      employee: employee ? employee._id : null,
      employeeName: isCustomer ? customer.name : req.user.name,
      amount: Number(amount),
      type,
      method: method || 'Cash',
      status: txStatus,
      notes,
    });

    // Only update balance immediately for approved transactions
    if (txStatus === 'approved') {
      if (type === 'deposit') {
        customer.balance += Number(amount);
        customer.totalDeposits += Number(amount);
      } else {
        customer.balance -= Number(amount);
        customer.totalWithdrawals += Number(amount);
      }
      await customer.save();

      if (employee) {
        if (type === 'deposit') employee.collections += Number(amount);
        else employee.withdrawals += Number(amount);
        await employee.save();
      }
    }

    const actionDesc = isCustomer
      ? `${customer.name} requested withdrawal of GH₵${Number(amount).toLocaleString()}`
      : `${req.user.name} recorded ${type} of GH₵${Number(amount).toLocaleString()} for ${customer.name}`;
    logActivity(type, req.user.name, req.user.role, actionDesc, { amount: Number(amount), customer: customer.name, status: txStatus });

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
    logActivity('approval', req.user.name, req.user.role, `${req.user.name} ${status} transaction #${req.params.id}`, { status });
    res.json({ success: true, data: tx });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/transactions/:id — delete single transaction (Super Admin only)
router.delete('/:id', requireRole('Super Admin'), async (req, res) => {
  try {
    const tx = await Transaction.findByIdAndDelete(req.params.id);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found.' });
    logActivity('transaction_delete', req.user.name, req.user.role, `${req.user.name} deleted transaction for ${tx.customerName || ''} — GH₵${tx.amount}`, { amount: tx.amount, customer: tx.customerName });
    res.json({ success: true, message: 'Transaction deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
