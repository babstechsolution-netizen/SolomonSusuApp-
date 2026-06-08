const express = require('express');
const Transaction = require('../models/Transaction');
const Customer = require('../models/Customer');
const Employee = require('../models/Employee');
const Setting = require('../models/Setting');
const { protect, requireRole } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { sync, notify } = require('../socket');

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
    const ws = await getWithdrawalSettings();
    const amt = Number(amount);

    if (type === 'withdrawal') {
      const fee = Math.round(amt * ws.feePercent / 100 * 100) / 100;
      const totalDeduction = amt + fee;

      // Customers: validate min balance and fee
      if (isCustomer) {
        if (customer.balance <= ws.minBalance) {
          return res.status(400).json({
            success: false,
            message: `Your balance (GH₵${customer.balance.toLocaleString()}) is at or below the minimum required balance of GH₵${ws.minBalance.toLocaleString()}. Withdrawal not allowed.`,
          });
        }
        if (totalDeduction > customer.balance - ws.minBalance) {
          const maxAllowed = Math.max(0, (customer.balance - ws.minBalance) / (1 + ws.feePercent / 100));
          return res.status(400).json({
            success: false,
            message: `Amount too high. With a ${ws.feePercent}% fee and minimum balance of GH₵${ws.minBalance}, you can withdraw up to GH₵${maxAllowed.toFixed(2)}.`,
          });
        }
      }

      // Employees/admin immediate approval: check balance
      if (!isCustomer && totalDeduction > customer.balance) {
        return res.status(400).json({ success: false, message: 'Insufficient balance.' });
      }
    }

    const fee = type === 'withdrawal' ? Math.round(amt * ws.feePercent / 100 * 100) / 100 : 0;

    const tx = await Transaction.create({
      customer: customer._id,
      customerName: customer.name,
      employee: employee ? employee._id : null,
      employeeName: isCustomer ? customer.name : req.user.name,
      amount: amt,
      type,
      method: method || 'Cash',
      status: txStatus,
      notes,
      feePercent: type === 'withdrawal' ? ws.feePercent : 0,
      feeAmount: fee,
    });

    // Only update balance immediately for approved transactions
    if (txStatus === 'approved') {
      if (type === 'deposit') {
        customer.balance += amt;
        customer.totalDeposits += amt;
      } else {
        customer.balance -= (amt + fee);
        customer.totalWithdrawals += amt;
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

    // Broadcast to all clients and send notification to admin
    sync('transactions', 'create', tx);
    notify({
      id: tx._id,
      type: tx.type,
      message: isCustomer
        ? `${customer.name} requested withdrawal of GH₵${Number(amount).toLocaleString()}`
        : `${type === 'deposit' ? 'Deposit' : 'Withdrawal'} of GH₵${Number(amount).toLocaleString()} recorded for ${customer.name} by ${req.user.name}`,
      status: txStatus,
      amount: Number(amount),
      customer: customer.name,
      time: new Date().toISOString(),
    });

    res.status(201).json({ success: true, data: tx });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/transactions/:id/status
router.patch('/:id/status', requireRole('Super Admin', 'Branch Manager', 'Accountant'), async (req, res) => {
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
    }

    tx.status = status;
    tx.approvedBy = req.user._id;
    await tx.save();

    logActivity('approval', req.user.name, req.user.role, `${req.user.name} ${status} ${tx.type} of GH₵${tx.amount} for ${tx.customerName}`, { status, amount: tx.amount, customer: tx.customerName });
    sync('transactions', 'update', tx);
    if (status === 'approved') {
      notify({ id: tx._id, type: 'approval', message: `${tx.type} of GH₵${tx.amount} for ${tx.customerName} was ${status}`, amount: tx.amount, customer: tx.customerName, time: new Date().toISOString() });
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
