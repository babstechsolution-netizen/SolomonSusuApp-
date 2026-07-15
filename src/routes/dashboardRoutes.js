const express = require('express');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Customer = require('../models/Customer');
const Employee = require('../models/Employee');
const Loan = require('../models/Loan');
const { protect, requireRoleOrPriv } = require('../middleware/auth');
const { resolveDateRange } = require('../utils/dateRange');

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
      totalBalance, activeLoans, overdueLoans, profit,
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
      // Company net profit = susu commissions (first deposit each month) + withdrawal fees
      Transaction.aggregate([
        { $match: { status: 'approved' } },
        { $group: { _id: null, commissions: { $sum: { $cond: ['$isCommission', '$amount', 0] } }, fees: { $sum: '$feeAmount' } } },
      ]),
    ]);

    const p = profit[0] || { commissions: 0, fees: 0 };
    res.json({
      success: true,
      data: {
        totalCustomers, activeCustomers,
        totalEmployees, activeEmployees,
        todayDeposits: todayDeposits[0] || { total: 0, count: 0 },
        todayWithdrawals: todayWithdrawals[0] || { total: 0, count: 0 },
        totalBalance: (totalBalance[0] || {}).total || 0,
        activeLoans, overdueLoans,
        companyProfit: (p.commissions || 0) + (p.fees || 0),
        commissionTotal: p.commissions || 0,
        feeTotal: p.fees || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/dashboard/timeseries?days=7  — deposits vs withdrawals per day for the dashboard chart
router.get('/timeseries', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 7));
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    const startStr = start.toISOString().split('T')[0];

    const agg = await Transaction.aggregate([
      { $match: { status: 'approved', date: { $gte: startStr } } },
      { $group: { _id: { date: '$date', type: '$type' }, total: { $sum: '$amount' } } },
    ]);

    // Build a continuous series so days with no activity still appear (consistent chart on every device)
    const byDate = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = d.toISOString().split('T')[0];
      byDate[key] = { date: key, deposits: 0, withdrawals: 0 };
    }
    agg.forEach((row) => {
      const bucket = byDate[row._id.date];
      if (!bucket) return;
      if (row._id.type === 'deposit') bucket.deposits = row.total;
      else if (row._id.type === 'withdrawal') bucket.withdrawals = row.total;
    });

    res.json({ success: true, data: Object.values(byDate) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/dashboard/period-summary?period=today|week|month|year|all
router.get('/period-summary', async (req, res) => {
  try {
    const period = (req.query.period || 'today').toLowerCase();
    const { from } = resolveDateRange({ period });

    const match = { status: 'approved' };
    if (from) match.date = { $gte: from };
    const agg = await Transaction.aggregate([
      { $match: match },
      { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    const dep = agg.find((a) => a._id === 'deposit') || { total: 0, count: 0 };
    const wit = agg.find((a) => a._id === 'withdrawal') || { total: 0, count: 0 };
    res.json({
      success: true,
      data: {
        period, from,
        deposits: { total: dep.total || 0, count: dep.count || 0 },
        withdrawals: { total: wit.total || 0, count: wit.count || 0 },
        net: (dep.total || 0) - (wit.total || 0),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/dashboard/reports?period=today|week|month|year|all&from=&to=&employee=
// Admin/manager view of collections & withdrawals, filterable by date period (or custom
// from/to range) and by employee. Per-employee totals are computed live from transactions
// in the selected range, not the employee's all-time running totals.
router.get('/reports', requireRoleOrPriv(['Super Admin', 'Branch Manager', 'Accountant'], 'view_reports'), async (req, res) => {
  try {
    const { from, to } = resolveDateRange(req.query);

    const match = { status: 'approved' };
    if (from || to) {
      match.date = {};
      if (from) match.date.$gte = from;
      if (to) match.date.$lte = to;
    }
    // aggregate() does not auto-cast query strings to ObjectId the way find() does — cast explicitly
    // or the $match silently matches nothing.
    if (req.query.employee && mongoose.Types.ObjectId.isValid(req.query.employee)) {
      match.employee = new mongoose.Types.ObjectId(req.query.employee);
    }

    const byMonth = await Transaction.aggregate([
      { $match: match },
      { $group: {
        _id: { month: { $substr: ['$date', 0, 7] }, type: '$type' },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      }},
      { $sort: { '_id.month': 1 } },
    ]);

    const byMethod = await Transaction.aggregate([
      { $match: match },
      { $group: { _id: '$method', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]);

    // Per-employee collected/withdrawn for the selected range (excludes customer self-service
    // transactions, which have no employee attached).
    const byEmployeeMatch = { ...match, employee: match.employee || { $ne: null } };
    const byEmployee = await Transaction.aggregate([
      { $match: byEmployeeMatch },
      { $group: { _id: { employee: '$employee', type: '$type' }, total: { $sum: '$amount' } } },
    ]);

    const empIds = [...new Set(byEmployee.map((r) => String(r._id.employee)))];
    const emps = await Employee.find({ _id: { $in: empIds } }).select('name zone color performance').lean();
    const empMap = {};
    emps.forEach((e) => { empMap[e._id] = e; });

    const statsByEmp = {};
    byEmployee.forEach((r) => {
      const id = String(r._id.employee);
      if (!statsByEmp[id]) statsByEmp[id] = { collected: 0, withdrawn: 0 };
      if (r._id.type === 'deposit') statsByEmp[id].collected = r.total;
      else if (r._id.type === 'withdrawal') statsByEmp[id].withdrawn = r.total;
    });

    const topEmployees = Object.keys(statsByEmp)
      .map((id) => ({
        _id: id,
        name: (empMap[id] || {}).name || 'Unknown',
        zone: (empMap[id] || {}).zone || '',
        color: (empMap[id] || {}).color,
        performance: (empMap[id] || {}).performance,
        collections: statsByEmp[id].collected,
        withdrawals: statsByEmp[id].withdrawn,
      }))
      .sort((a, b) => b.collections - a.collections);

    res.json({ success: true, data: { byMonth, byMethod, topEmployees, range: { from, to } } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
