const express = require('express');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Employee = require('../models/Employee');
const CashHandover = require('../models/CashHandover');
const { protect, requireRoleOrPriv } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { createNotification } = require('../utils/notify');
const { sync } = require('../socket');

const router = express.Router();
router.use(protect);

// Same gate as approving transactions — a manager (or anyone delegated approve_transactions)
// is trusted to both approve pending withdrawals and reconcile a collector's daily cash.
const canAudit = requireRoleOrPriv(['Super Admin', 'Branch Manager', 'Accountant'], 'approve_transactions');

async function unreconciledCashDeposits(employeeId, date) {
  return Transaction.find({
    employee: employeeId, date, type: 'deposit', method: 'Cash', status: 'approved', reconciled: false,
  });
}

// GET /api/cash-handovers/summary?employee=&date=  — what a manager sees before counting cash:
// the system-recorded total still awaiting reconciliation for that collector/day, or the
// outcome if that day was already handled.
router.get('/summary', canAudit, async (req, res) => {
  try {
    const { employee, date } = req.query;
    if (!employee || !mongoose.Types.ObjectId.isValid(employee)) {
      return res.status(400).json({ success: false, message: 'A valid employee id is required.' });
    }
    const d = date || new Date().toISOString().split('T')[0];
    const [txns, existing] = await Promise.all([
      unreconciledCashDeposits(employee, d),
      CashHandover.findOne({ employee, date: d }).lean(),
    ]);
    const systemTotal = Math.round(txns.reduce((s, t) => s + t.amount, 0) * 100) / 100;
    res.json({ success: true, data: { date: d, systemTotal, pendingCount: txns.length, handover: existing || null } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cash-handovers — the manager counts the physical cash and submits it against the
// system total for that collector/day. An exact match reconciles immediately, releasing those
// deposits into company-wide totals; any mismatch is recorded but holds them back until it is
// explicitly approved via PATCH /:id/approve.
router.post('/', canAudit, async (req, res) => {
  try {
    const { employeeId, date, cashReceived, notes } = req.body;
    if (!employeeId || !mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ success: false, message: 'A valid employee id is required.' });
    }
    if (cashReceived === undefined || cashReceived === null || isNaN(Number(cashReceived)) || Number(cashReceived) < 0) {
      return res.status(400).json({ success: false, message: 'A valid cash received amount is required.' });
    }
    const emp = await Employee.findById(employeeId);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });

    const d = date || new Date().toISOString().split('T')[0];
    const txns = await unreconciledCashDeposits(employeeId, d);
    if (!txns.length) {
      const already = await CashHandover.findOne({ employee: employeeId, date: d });
      if (already) return res.status(400).json({ success: false, message: 'This day has already been reconciled.' });
      return res.status(400).json({ success: false, message: 'No cash collections recorded for this employee on this day.' });
    }

    const systemTotal = Math.round(txns.reduce((s, t) => s + t.amount, 0) * 100) / 100;
    const received = Math.round(Number(cashReceived) * 100) / 100;
    const variance = Math.round((received - systemTotal) * 100) / 100;
    const status = variance === 0 ? 'reconciled' : 'flagged';

    const handover = await CashHandover.findOneAndUpdate(
      { employee: employeeId, date: d },
      {
        employee: employeeId,
        employeeName: emp.name,
        date: d,
        systemTotal,
        cashReceived: received,
        variance,
        status,
        notes,
        transactionIds: txns.map((t) => t._id),
        reconciledBy: status === 'reconciled' ? req.user._id : null,
        reconciledByName: status === 'reconciled' ? req.user.name : null,
      },
      { upsert: true, new: true, runValidators: true },
    );

    if (status === 'reconciled') {
      await Transaction.updateMany(
        { _id: { $in: txns.map((t) => t._id) } },
        { reconciled: true, cashHandover: handover._id },
      );
    }

    logActivity(
      'cash_handover',
      req.user.name,
      req.user.role,
      `${req.user.name} recorded a cash handover for ${emp.name} (${d}): system GH₵${systemTotal.toLocaleString()}, received GH₵${received.toLocaleString()}${variance !== 0 ? `, variance GH₵${variance.toLocaleString()}` : ''}`,
      { employee: emp.name, date: d, systemTotal, cashReceived: received, variance, status },
    );

    if (status === 'flagged') {
      // A cash mismatch is exactly the kind of thing that must never go unnoticed — alert
      // every admin/manager account, the same way transaction deletions do.
      ['Super Admin', 'Branch Manager'].forEach((r) => {
        createNotification({
          recipientRole: r,
          type: 'cash_handover',
          title: 'Cash Handover Mismatch',
          body: `${emp.name}'s cash for ${d} is off by GH₵${Math.abs(variance).toLocaleString()} (${variance > 0 ? 'excess' : 'short'}). Needs approval before it counts.`,
          amount: variance,
          customer: emp.name,
        });
      });
    }

    sync('cashHandovers', 'update', handover);
    res.status(201).json({ success: true, data: handover });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/cash-handovers/:id/approve — manager signs off on a flagged (mismatched) handover
// so the collector's transactions are finally released into company totals despite the variance.
router.patch('/:id/approve', canAudit, async (req, res) => {
  try {
    const handover = await CashHandover.findById(req.params.id);
    if (!handover) return res.status(404).json({ success: false, message: 'Cash handover not found.' });
    if (handover.status === 'reconciled') {
      return res.json({ success: true, data: handover, message: 'Already reconciled.' });
    }

    handover.status = 'reconciled';
    handover.reconciledBy = req.user._id;
    handover.reconciledByName = req.user.name;
    if (req.body && req.body.notes) {
      handover.notes = (handover.notes ? handover.notes + ' · ' : '') + req.body.notes;
    }
    await handover.save();

    await Transaction.updateMany(
      { _id: { $in: handover.transactionIds } },
      { reconciled: true, cashHandover: handover._id },
    );

    logActivity(
      'cash_handover_approve',
      req.user.name,
      req.user.role,
      `${req.user.name} approved ${handover.employeeName}'s cash handover for ${handover.date} despite a GH₵${Math.abs(handover.variance).toLocaleString()} variance`,
      { employee: handover.employeeName, date: handover.date, variance: handover.variance },
    );

    sync('cashHandovers', 'update', handover);
    res.json({ success: true, data: handover });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// GET /api/cash-handovers — history, filterable by employee / date range / status
router.get('/', canAudit, async (req, res) => {
  try {
    const filter = {};
    if (req.query.employee && mongoose.Types.ObjectId.isValid(req.query.employee)) filter.employee = req.query.employee;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.from || req.query.to) {
      filter.date = {};
      if (req.query.from) filter.date.$gte = req.query.from;
      if (req.query.to) filter.date.$lte = req.query.to;
    }
    const list = await CashHandover.find(filter).sort({ date: -1 }).limit(200).lean();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
