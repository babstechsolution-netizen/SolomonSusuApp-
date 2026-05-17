const express = require('express');
const Transaction = require('../models/Transaction');
const Customer = require('../models/Customer');
const Employee = require('../models/Employee');
const Loan = require('../models/Loan');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

// GET /api/dashboard  — main dashboard stats
router.get('/', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [
      totalCustomers, activeCustomers,
      totalEmployees, activeEmployees,
      todayDeposits, todayWithdrawals,
      totalBalance, activeLoans, overdueLoans,
    ] = await Promise.all([
      Customer.countDocuments(),
      Customer.countDocuments({ status: 'active' }),
      Employee.countDocuments(),
      Employee.countDocuments({ status: 'active' }),
      Transaction.aggregate([{ $match: { type: 'deposit', status: 'approved', date: today } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Transaction.aggregate([{ $match: { type: 'withdrawal', status: 'approved', date: today } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Customer.aggregate([{ $group: { _id: null, total: { $sum: '$balance' } } }]),
      Loan.countDocuments({ status: 'active' }),
      Loan.countDocuments({ status: 'overdue' }),
    ]);

    res.json({
      success: true,
      data: {
        totalCustomers, activeCustomers,
        totalEmployees, activeEmployees,
        todayDeposits: todayDeposits[0] || { total: 0, count: 0 },
        todayWithdrawals: todayWithdrawals[0] || { total: 0, count: 0 },
        totalBalance: (totalBalance[0] || {}).total || 0,
        activeLoans, overdueLoans,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/dashboard/reports  — monthly aggregated data
router.get('/reports', async (req, res) => {
  try {
    const byMonth = await Transaction.aggregate([
      { $match: { status: 'approved' } },
      { $group: {
        _id: { month: { $substr: ['$date', 0, 7] }, type: '$type' },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      }},
      { $sort: { '_id.month': 1 } },
    ]);

    const byMethod = await Transaction.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: '$method', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]);

    const topEmployees = await Employee.find().sort({ collections: -1 }).limit(5).select('name zone collections performance color');

    res.json({ success: true, data: { byMonth, byMethod, topEmployees } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
