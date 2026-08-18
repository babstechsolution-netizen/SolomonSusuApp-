const express = require('express');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Customer = require('../models/Customer');
const Employee = require('../models/Employee');
const Setting = require('../models/Setting');
const User = require('../models/User');
const { protect, requireRole, requireRoleOrPriv } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { createNotification } = require('../utils/notify');
const { resolveDateRange } = require('../utils/dateRange');
const { sync } = require('../socket');

async function getWithdrawalSettings() {
  const s = await Setting.findOne({ key: 'withdrawalSettings' });
  return { minBalance: 0, feePercent: 0, ...(s?.value || {}) };
}

const router = express.Router();
router.use(protect);

// GET /api/transactions/withdrawal-settings — public (any logged-in user)
router.get('/withdrawal-settings', async (req, res) => {
  try {
    const ws = await getWithdrawalSettings();
    res.json({ success: true, data: ws });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/transactions/collector-summary — today's figures for the logged-in collector.
// Server-computed so every device shows identical numbers.
router.get('/collector-summary', async (req, res) => {
  try {
    const emp = await Employee.findOne({ userId: req.user._id });
    if (!emp) {
      return res.json({ success: true, data: { collected: 0, withdrawn: 0, visited: 0, remaining: 0, totalAssigned: 0, dailyTarget: 0, progress: 0 } });
    }
    const today = new Date().toISOString().split('T')[0];

    const [depAgg, witAgg, visitedIds, totalAssigned] = await Promise.all([
      Transaction.aggregate([{ $match: { employee: emp._id, type: 'deposit', status: 'approved', date: today } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Transaction.aggregate([{ $match: { employee: emp._id, type: 'withdrawal', status: 'approved', date: today } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Transaction.distinct('customer', { employee: emp._id, type: 'deposit', date: today }),
      Customer.countDocuments({ assignedEmployee: emp._id }),
    ]);

    const collected = (depAgg[0] || {}).total || 0;
    const withdrawn = (witAgg[0] || {}).total || 0;
    const visited = visitedIds.length;
    const dailyTarget = emp.dailyTarget || 0;

    res.json({
      success: true,
      data: {
        collected,
        withdrawn,
        visited,
        remaining: Math.max(0, totalAssigned - visited),
        totalAssigned,
        dailyTarget,
        progress: dailyTarget > 0 ? Math.min(100, Math.round((collected / dailyTarget) * 100)) : 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/transactions  — supports ?period=today|week|month|year|all or ?from=&to= for a
// custom date range, plus ?employee= to scope to one collector (admin/manager filtering).
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.type) filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.method) filter.method = req.query.method;
    if (req.query.date) {
      filter.date = req.query.date;
    } else if (req.query.period || req.query.from || req.query.to) {
      const { from, to } = resolveDateRange(req.query);
      if (from || to) {
        filter.date = {};
        if (from) filter.date.$gte = from;
        if (to) filter.date.$lte = to;
      }
    }
    // Role-based scoping is enforced here, server-side — a Customer or plain Field Collector
    // must never be able to see another person's records just by sending a different
    // ?employee= or ?customer= id. Admin/manager/accountant roles pass those filters freely.
    // A Field Collector who has been delegated 'view_all_transactions' or 'view_reports'
    // (e.g. given the "Branch Manager" job title via Roles & Privileges, without changing
    // their login role) is exempted the same way — otherwise the privilege grant would be
    // silently ineffective, since this scoping would still clamp them to their own records.
    if (req.user.role === 'Customer') {
      filter.customer = req.user.customerId;
    } else if (req.user.role === 'Field Collector') {
      const emp = await Employee.findOne({ userId: req.user._id }).select('_id privileges');
      const privs = (emp && emp.privileges) || [];
      const canSeeAll = privs.includes('view_all_transactions') || privs.includes('view_reports');
      if (canSeeAll) {
        if (req.query.employee) filter.employee = req.query.employee;
        if (req.query.customer) filter.customer = req.query.customer;
      } else {
        filter.employee = emp ? emp._id : new mongoose.Types.ObjectId();
      }
    } else {
      if (req.query.employee) filter.employee = req.query.employee;
      if (req.query.customer) filter.customer = req.query.customer;
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [data, total, sumAgg] = await Promise.all([
      Transaction.find(filter)
        .populate('customer', 'name phone')
        .populate('employee', 'name zone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments(filter),
      Transaction.aggregate([
        // aggregate() doesn't auto-cast query strings to ObjectId like find()/countDocuments() do,
        // so employee/customer ids must be cast explicitly or the $match silently matches nothing.
        { $match: {
          ...filter,
          status: 'approved',
          ...(filter.employee && mongoose.Types.ObjectId.isValid(filter.employee) ? { employee: new mongoose.Types.ObjectId(filter.employee) } : {}),
          ...(filter.customer && mongoose.Types.ObjectId.isValid(filter.customer) ? { customer: new mongoose.Types.ObjectId(filter.customer) } : {}),
        } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    res.json({ success: true, data, total, page, pages: Math.ceil(total / limit), sum: (sumAgg[0] || {}).total || 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/transactions  (deposit or withdrawal; customers create pending withdrawal requests)
router.post('/', async (req, res) => {
  try {
    const isCustomer = req.user.role === 'Customer';
    const { amount, type, method, notes, idempotencyKey } = req.body;

    // Offline retry safety: if this exact submission was already recorded, return it unchanged.
    if (idempotencyKey) {
      const existing = await Transaction.findOne({ idempotencyKey });
      if (existing) return res.status(200).json({ success: true, data: existing, duplicate: true });
    }
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
    const ws = await getWithdrawalSettings();
    const amt = Number(amount);

    // Approval policy: deposits go through immediately; withdrawals need admin/manager
    // approval unless the recorder is an admin/manager or has the approve_transactions privilege.
    const canApprove = req.user.role === 'Super Admin' || req.user.role === 'Branch Manager'
      || (employee && Array.isArray(employee.privileges) && employee.privileges.includes('approve_transactions'));
    let txStatus;
    if (isCustomer) txStatus = 'pending';
    else if (type === 'deposit') txStatus = 'approved';
    else txStatus = canApprove ? 'approved' : 'pending';

    const fee = type === 'withdrawal' ? Math.round(amt * ws.feePercent / 100 * 100) / 100 : 0;

    if (type === 'withdrawal') {
      const totalDeduction = amt + fee;
      // Customers: validate min balance and fee
      if (isCustomer) {
        if (customer.balance <= ws.minBalance) {
          return res.status(400).json({ success: false, message: `Your balance (GH₵${customer.balance.toLocaleString()}) is at or below the minimum required balance of GH₵${ws.minBalance.toLocaleString()}. Withdrawal not allowed.` });
        }
        if (totalDeduction > customer.balance - ws.minBalance) {
          const maxAllowed = Math.max(0, (customer.balance - ws.minBalance) / (1 + ws.feePercent / 100));
          return res.status(400).json({ success: false, message: `Amount too high. With a ${ws.feePercent}% fee and minimum balance of GH₵${ws.minBalance}, you can withdraw up to GH₵${maxAllowed.toFixed(2)}.` });
        }
      }
      // Only block immediately-approved withdrawals for insufficient balance; pending ones re-check at approval.
      if (txStatus === 'approved' && totalDeduction > customer.balance) {
        return res.status(400).json({ success: false, message: 'Insufficient balance.' });
      }
    }

    // Susu commission: the FIRST deposit of each calendar month is taken as company profit.
    const currentMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
    const isCommission = (type === 'deposit' && txStatus === 'approved' && customer.lastCommissionMonth !== currentMonth);

    const tx = await Transaction.create({
      customer: customer._id,
      customerName: customer.name,
      employee: employee ? employee._id : null,
      employeeName: isCustomer ? customer.name : req.user.name,
      amount: amt,
      type,
      method: method || 'Cash',
      status: txStatus,
      notes: isCommission ? ((notes ? notes + ' · ' : '') + 'First deposit — susu commission') : notes,
      feePercent: type === 'withdrawal' ? ws.feePercent : 0,
      feeAmount: fee,
      isCommission,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    // Update balances only for approved transactions
    if (txStatus === 'approved') {
      if (type === 'deposit') {
        if (isCommission) {
          // Monthly susu commission: taken as company profit, NOT added to savings balance.
          // Recorded on the account (totalDeposits) and shown in history so the deduction is visible.
          customer.lastCommissionMonth = currentMonth;
          customer.totalDeposits += amt;
        } else {
          customer.balance += amt;
          customer.totalDeposits += amt;
        }
      } else {
        customer.balance -= (amt + fee);
        customer.totalWithdrawals += amt;
      }
      await customer.save();

      if (employee) {
        if (type === 'deposit') employee.collections += amt;
        else employee.withdrawals += amt;
        await employee.save();
      }
    }

    const actionDesc = isCustomer
      ? `${customer.name} requested withdrawal of GH₵${Number(amount).toLocaleString()}`
      : `${req.user.name} recorded ${type} of GH₵${Number(amount).toLocaleString()} for ${customer.name}`;
    logActivity(type, req.user.name, req.user.role, actionDesc, { amount: Number(amount), customer: customer.name, status: txStatus });

    // Broadcast to all clients (real-time) and persist notifications so any device sees the history
    sync('transactions', 'create', tx);

    const amountStr = Number(amount).toLocaleString();
    // Notify admins AND managers for oversight — both roles carry approval/oversight
    // responsibility in this app, so both must see every transaction as it happens.
    ['Super Admin', 'Branch Manager'].forEach((role) => {
      createNotification({
        recipientRole: role,
        type: tx.type,
        title: isCustomer ? 'Withdrawal Request' : `${type === 'deposit' ? 'Deposit' : 'Withdrawal'} Recorded`,
        body: isCustomer
          ? `${customer.name} requested withdrawal of GH₵${amountStr}`
          : `${type === 'deposit' ? 'Deposit' : 'Withdrawal'} of GH₵${amountStr} recorded for ${customer.name} by ${req.user.name}`,
        amount: Number(amount),
        customer: customer.name,
      });
    });
    // Notify the customer (if they have a login) so it shows on their own device
    const custUser = await User.findOne({ customerId: customer._id }).select('_id');
    if (custUser) {
      createNotification({
        recipientUser: custUser._id,
        type: tx.type,
        title: type === 'deposit' ? 'Deposit Recorded' : (isCustomer ? 'Withdrawal Requested' : 'Withdrawal Recorded'),
        body: type === 'deposit'
          ? `GH₵${amountStr} was added to your savings. New balance: GH₵${customer.balance.toLocaleString()}.`
          : (isCustomer
              ? `Your withdrawal request for GH₵${amountStr} is pending approval.`
              : `A withdrawal of GH₵${amountStr} was recorded on your account.`),
        amount: Number(amount),
        customer: customer.name,
      });
    }

    res.status(201).json({ success: true, data: tx });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/transactions/:id/status
router.patch('/:id/status', requireRoleOrPriv(['Super Admin', 'Branch Manager', 'Accountant'], 'approve_transactions'), async (req, res) => {
  try {
    const { status } = req.body;
    const tx = await Transaction.findById(req.params.id);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found.' });

    // Only update balance when moving from pending → approved/rejected
    if (tx.status === 'pending' && status === 'approved') {
      const customer = await Customer.findById(tx.customer);
      if (customer) {
        const fee = tx.feeAmount || 0;
        if (tx.type === 'withdrawal') {
          if (tx.amount + fee > customer.balance) {
            return res.status(400).json({ success: false, message: 'Customer has insufficient balance to approve this withdrawal.' });
          }
          customer.balance -= (tx.amount + fee);
          customer.totalWithdrawals += tx.amount;
        } else {
          customer.balance += tx.amount;
          customer.totalDeposits += tx.amount;
        }
        await customer.save();
      }
      // Keep the employee's running collected/withdrawn totals in sync — they were skipped at
      // creation time because the transaction wasn't approved yet.
      if (tx.employee) {
        const field = tx.type === 'withdrawal' ? 'withdrawals' : 'collections';
        await Employee.findByIdAndUpdate(tx.employee, { $inc: { [field]: tx.amount } });
      }
    }

    tx.status = status;
    tx.approvedBy = req.user._id;
    await tx.save();

    logActivity('approval', req.user.name, req.user.role, `${req.user.name} ${status} ${tx.type} of GH₵${tx.amount} for ${tx.customerName}`, { status, amount: tx.amount, customer: tx.customerName });
    sync('transactions', 'update', tx);
    if (status === 'approved' || status === 'rejected') {
      // Tell the customer their request outcome (shows on their device history)
      const custUser = await User.findOne({ customerId: tx.customer }).select('_id');
      if (custUser) {
        createNotification({
          recipientUser: custUser._id,
          type: 'approval',
          title: status === 'approved' ? 'Withdrawal Approved' : 'Withdrawal Rejected',
          body: `Your ${tx.type} of GH₵${Number(tx.amount).toLocaleString()} was ${status}.`,
          amount: tx.amount,
          customer: tx.customerName,
        });
      }
    }
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
    sync('transactions', 'delete', { _id: tx._id });
    // Fraud safeguard: deleting a transaction erases evidence, so this can never be a quiet
    // action — every admin/manager account is notified in real time, not just logged for
    // someone to notice later in the activity log.
    ['Super Admin', 'Branch Manager'].forEach((role) => {
      createNotification({
        recipientRole: role,
        type: 'transaction_delete',
        title: 'Transaction Deleted',
        body: `${req.user.name} deleted a ${tx.type} of GH₵${Number(tx.amount).toLocaleString()} for ${tx.customerName || 'a customer'}.`,
        amount: tx.amount,
        customer: tx.customerName,
      });
    });
    res.json({ success: true, message: 'Transaction deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/transactions  — wipe all (Super Admin only)
router.delete('/', requireRole('Super Admin'), async (req, res) => {
  try {
    const count = await Transaction.countDocuments({});
    await Transaction.deleteMany({});
    logActivity('transaction_delete', req.user.name, req.user.role, `${req.user.name} wiped ALL ${count} transactions from the system.`, { count });
    ['Super Admin', 'Branch Manager'].forEach((role) => {
      createNotification({
        recipientRole: role,
        type: 'transaction_delete',
        title: 'ALL Transactions Wiped',
        body: `${req.user.name} deleted all ${count} transaction records from the system.`,
      });
    });
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

// GET /api/transactions/stats — authoritative deposit/withdrawal totals for dashboards,
// computed by aggregation over the full collection. The client-side dashboard used to derive
// these numbers from a capped, 200-record local cache, which silently undercounted totals
// (and could make discrepancies caused by fraud harder to spot) once a shop had more history
// than that. Supports the same ?period=|?from=&to=|?date= and ?employee=/?customer= filters
// as GET /, with the same server-side role scoping.
router.get('/stats', async (req, res) => {
  try {
    const filter = { status: 'approved' };
    if (req.query.date) {
      filter.date = req.query.date;
    } else if (req.query.period || req.query.from || req.query.to) {
      const { from, to } = resolveDateRange(req.query);
      if (from || to) {
        filter.date = {};
        if (from) filter.date.$gte = from;
        if (to) filter.date.$lte = to;
      }
    }
    if (req.user.role === 'Customer') {
      filter.customer = req.user.customerId;
    } else if (req.user.role === 'Field Collector') {
      const emp = await Employee.findOne({ userId: req.user._id }).select('_id privileges');
      const privs = (emp && emp.privileges) || [];
      const canSeeAll = privs.includes('view_all_transactions') || privs.includes('view_reports');
      if (canSeeAll) {
        if (req.query.employee) filter.employee = req.query.employee;
        if (req.query.customer) filter.customer = req.query.customer;
      } else {
        filter.employee = emp ? emp._id : new mongoose.Types.ObjectId();
      }
    } else {
      if (req.query.employee) filter.employee = req.query.employee;
      if (req.query.customer) filter.customer = req.query.customer;
    }

    const matchStage = {
      ...filter,
      ...(filter.employee && mongoose.Types.ObjectId.isValid(filter.employee) ? { employee: new mongoose.Types.ObjectId(filter.employee) } : {}),
      ...(filter.customer && mongoose.Types.ObjectId.isValid(filter.customer) ? { customer: new mongoose.Types.ObjectId(filter.customer) } : {}),
    };

    const agg = await Transaction.aggregate([
      { $match: matchStage },
      { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    const deposit = agg.find((a) => a._id === 'deposit') || { total: 0, count: 0 };
    const withdrawal = agg.find((a) => a._id === 'withdrawal') || { total: 0, count: 0 };

    res.json({
      success: true,
      data: {
        totalDeposits: deposit.total || 0,
        depositCount: deposit.count || 0,
        totalWithdrawals: withdrawal.total || 0,
        withdrawalCount: withdrawal.count || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
