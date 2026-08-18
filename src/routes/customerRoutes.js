const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const Customer = require('../models/Customer');
const User = require('../models/User');
const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const { protect, requireRole } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { createNotification } = require('../utils/notify');
const { sync } = require('../socket');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();
router.use(protect);

// GET /api/customers
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.employee) filter.assignedEmployee = req.query.employee;
    if (req.query.status) filter.status = req.query.status;
    const customers = await Customer.find(filter).populate('assignedEmployee', 'name zone phone').sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: customers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/customers/me — logged-in customer sees their own profile
router.get('/me', async (req, res) => {
  try {
    if (req.user.role !== 'Customer') return res.status(403).json({ success: false, message: 'Not a customer account.' });
    if (!req.user.customerId) return res.status(404).json({ success: false, message: 'No customer profile linked to this account.' });
    const cust = await Customer.findById(req.user.customerId).populate('assignedEmployee', 'name phone zone');
    if (!cust) return res.status(404).json({ success: false, message: 'Customer profile not found.' });
    res.json({ success: true, data: cust });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/customers/export — download all customers as Excel
router.get('/export', requireRole('Super Admin', 'Branch Manager'), async (req, res) => {
  try {
    const customers = await Customer.find().sort({ createdAt: -1 });
    const rows = customers.map(c => ({
      name: c.name,
      phone: c.phone === 'N/A' ? '' : (c.phone || ''),
      business: c.business || '',
      location: c.location || '',
      status: c.status || 'active',
    }));
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(rows);
    // Set column widths
    ws['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 30 }, { wch: 30 }, { wch: 12 }];
    xlsx.utils.book_append_sheet(wb, ws, 'Customers');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="customers_${Date.now()}.xlsx"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/customers/orphaned — a deleted Customer leaves its Transaction history behind
// untouched, so a mistaken delete is recoverable: find every customer id referenced by a
// transaction that no longer has a matching Customer document, and rebuild a preview of
// what that account looked like (name + running balance) from the transaction trail alone.
router.get('/orphaned', requireRole('Super Admin'), async (req, res) => {
  try {
    const custIds = (await Transaction.distinct('customer')).filter(Boolean);
    if (!custIds.length) return res.json({ success: true, data: [] });
    const existing = await Customer.find({ _id: { $in: custIds } }).select('_id').lean();
    const existingSet = new Set(existing.map((c) => String(c._id)));
    const orphanIds = custIds.filter((id) => !existingSet.has(String(id)));

    const results = [];
    for (const id of orphanIds) {
      const txns = await Transaction.find({ customer: id }).sort({ createdAt: 1 }).lean();
      if (!txns.length) continue;
      let balance = 0;
      let totalDeposits = 0;
      let totalWithdrawals = 0;
      let assignedEmployee = null;
      txns.forEach((t) => {
        if (t.employee) assignedEmployee = t.employee;
        if (t.status !== 'approved') return;
        if (t.type === 'deposit') {
          totalDeposits += t.amount;
          if (!t.isCommission) balance += t.amount;
        } else if (t.type === 'withdrawal') {
          totalWithdrawals += t.amount;
          balance -= t.amount + (t.feeAmount || 0);
        }
      });
      const last = txns[txns.length - 1];
      results.push({
        id: String(id),
        name: last.customerName || txns[0].customerName || 'Unknown',
        balance,
        totalDeposits,
        totalWithdrawals,
        assignedEmployee,
        transactionCount: txns.length,
        lastActivity: last.date,
      });
    }
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/customers/:id/restore — recreate a deleted customer using the ORIGINAL id (the
// same one still referenced on their historic transactions), so nothing needs re-linking.
// Only fields that can't be recovered from transaction history (phone, business, location)
// come from the request body — phone is required since the schema requires it.
router.post('/:id/restore', requireRole('Super Admin'), async (req, res) => {
  try {
    const existing = await Customer.findById(req.params.id);
    if (existing) return res.status(400).json({ success: false, message: 'A customer with this id already exists — nothing to restore.' });

    const txns = await Transaction.find({ customer: req.params.id }).sort({ createdAt: 1 }).lean();
    if (!txns.length) return res.status(404).json({ success: false, message: 'No transaction history found for this id — nothing to restore.' });

    const { phone, name, business, location } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required to restore this customer.' });

    let balance = 0;
    let totalDeposits = 0;
    let totalWithdrawals = 0;
    let lastCommissionMonth = '';
    let assignedEmployee = null;
    txns.forEach((t) => {
      if (t.employee) assignedEmployee = t.employee;
      if (t.status !== 'approved') return;
      if (t.type === 'deposit') {
        totalDeposits += t.amount;
        if (t.isCommission) lastCommissionMonth = (t.date || '').slice(0, 7);
        else balance += t.amount;
      } else if (t.type === 'withdrawal') {
        totalWithdrawals += t.amount;
        balance -= t.amount + (t.feeAmount || 0);
      }
    });
    const last = txns[txns.length - 1];

    const cust = new Customer({
      _id: req.params.id,
      name: name || last.customerName || txns[0].customerName || 'Unknown',
      phone,
      business: business || '',
      location: location || '',
      status: 'active',
      balance,
      totalDeposits,
      totalWithdrawals,
      lastCommissionMonth,
      assignedEmployee,
    });
    await cust.save();

    logActivity('customer_restore', req.user.name, req.user.role, `${req.user.name} restored deleted customer ${cust.name}`, { customer: cust.name });
    sync('customers', 'create', cust);
    res.status(201).json({ success: true, data: cust });
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

// Flexible column finder — matches any keyword in the header (case-insensitive)
function pickCol(row, keywords) {
  const keys = Object.keys(row);
  for (const kw of keywords) {
    const found = keys.find(k => k.toLowerCase().replace(/[\s_\-]/g, '').includes(kw.replace(/[\s_\-]/g, '')));
    if (found) {
      const val = String(row[found] ?? '').trim();
      if (val) return val;
    }
  }
  return '';
}

// POST /api/customers/import — import from Excel file
router.post('/import', requireRole('Super Admin', 'Branch Manager'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

    let workbook;
    try {
      workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    } catch (e) {
      return res.status(400).json({ success: false, message: 'Could not read file. Make sure it is a valid .xlsx or .xls file.' });
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) return res.status(400).json({ success: false, message: 'Excel file is empty or has no data rows.' });

    // Parse a money value, tolerating currency symbols, commas and spaces (e.g. "GH₵ 1,200.50")
    const parseAmount = (v) => {
      const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
      return isNaN(n) ? 0 : n;
    };

    // Existing customer names (lowercased) so we can skip duplicates
    const existing = await Customer.find({}, 'name').lean();
    const existingNames = new Set(existing.map(c => (c.name || '').trim().toLowerCase()));
    const seenInFile = new Set();

    const colors = ['#ec4899', '#06b6d4', '#f59e0b', '#8b5cf6', '#3b82f6', '#10b981', '#ef4444', '#14b8a6'];
    const valid = [];
    const errors = [];
    const skippedDuplicates = [];
    const base = Date.now();

    rows.forEach((row, i) => {
      // Detect name from any recognisable column — fall back to first column value
      const name =
        pickCol(row, ['name', 'fullname', 'customername', 'clientname', 'customer', 'client']) ||
        String(Object.values(row)[0] ?? '').trim();

      if (!name) { errors.push(`Row ${i + 2}: could not detect a name — row skipped`); return; }

      // Skip duplicate names — already in the system or repeated within this file
      const nameKey = name.trim().toLowerCase();
      if (existingNames.has(nameKey) || seenInFile.has(nameKey)) {
        skippedDuplicates.push(name);
        return;
      }
      seenInFile.add(nameKey);

      // Account balance — the other detail columns can be filled in later
      const balance = parseAmount(
        pickCol(row, ['accountbalance', 'currentbalance', 'openingbalance', 'savingsbalance', 'balance', 'totalsavings', 'savings', 'amount', 'deposit', 'bal'])
      );

      // Phone is optional — admin can edit later
      const phone =
        pickCol(row, ['phone', 'mobile', 'tel', 'telephone', 'contact', 'phonenumber', 'mobilenumber', 'cell']);

      const business =
        pickCol(row, ['business', 'businessname', 'shop', 'shopname', 'company', 'trade', 'occupation', 'work']);

      const location =
        pickCol(row, ['location', 'address', 'area', 'zone', 'place', 'town', 'city', 'street', 'district', 'region']);

      valid.push({
        name,
        phone: phone || 'N/A',   // phone is required in schema; admin updates it later
        business,
        location,
        balance,
        totalDeposits: balance,  // opening balance counts as accumulated savings
        color: colors[i % colors.length],
        status: 'active',
        qrCode: `AW-${base}${i}`,
      });
    });

    if (!valid.length) {
      const reason = skippedDuplicates.length
        ? `No new customers imported — all ${skippedDuplicates.length} name(s) already exist.`
        : 'No rows could be imported — every row was missing a name.';
      return res.status(400).json({ success: false, message: reason, errors, skippedDuplicates });
    }

    const created = await Customer.insertMany(valid, { ordered: false });
    logActivity('customer_import', req.user.name, req.user.role, `${req.user.name} imported ${created.length} customer(s) from Excel`, { count: created.length, skipped: errors.length, duplicates: skippedDuplicates.length });
    let message = `${created.length} customer(s) imported successfully.`;
    if (skippedDuplicates.length) message += ` ${skippedDuplicates.length} duplicate name(s) skipped.`;
    res.json({
      success: true,
      message,
      data: created,
      errors,
      skippedDuplicates,
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Fields safe to set directly from the register/edit forms. balance/totalDeposits/totalWithdrawals
// are excluded on purpose — they must only ever move via a recorded transaction, so every cedi is
// traceable and reflected consistently in the dashboard, Reports and employee collection totals.
// (Bulk Excel import is the one sanctioned exception, for seeding opening balances — see /import.)
const CUSTOMER_EDITABLE_FIELDS = ['name', 'phone', 'business', 'location', 'status', 'dailyAmount', 'savingsTarget', 'photo', 'nationalId', 'color', 'startDate'];

// POST /api/customers
router.post('/', requireRole('Super Admin', 'Branch Manager', 'Field Collector'), async (req, res) => {
  try {
    const payload = {};
    CUSTOMER_EDITABLE_FIELDS.forEach((f) => { if (req.body[f] !== undefined) payload[f] = req.body[f]; });
    const cust = await Customer.create(payload);
    logActivity('customer_add', req.user.name, req.user.role, `${req.user.name} registered customer ${cust.name}`, { customer: cust.name, phone: cust.phone });
    sync('customers', 'create', cust);
    res.status(201).json({ success: true, data: cust });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/customers/:id — profile-only edit, same field allowlist as create.
router.patch('/:id', async (req, res) => {
  try {
    const updates = {};
    CUSTOMER_EDITABLE_FIELDS.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    const cust = await Customer.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!cust) return res.status(404).json({ success: false, message: 'Customer not found.' });
    logActivity('customer_edit', req.user.name, req.user.role, `${req.user.name} updated profile for customer ${cust.name}`, { customer: cust.name });
    sync('customers', 'update', cust);
    res.json({ success: true, data: cust });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/customers/bulk — delete multiple selected customers
router.delete('/bulk', requireRole('Super Admin'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ success: false, message: 'No IDs provided.' });
    const result = await Customer.deleteMany({ _id: { $in: ids } });
    logActivity('customer_bulk_delete', req.user.name, req.user.role, `${req.user.name} bulk-deleted ${result.deletedCount} customer(s)`, { count: result.deletedCount });
    res.json({ success: true, message: `${result.deletedCount} customer(s) deleted.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/customers/:id — delete single customer (Super Admin only)
router.delete('/:id', requireRole('Super Admin'), async (req, res) => {
  try {
    const cust = await Customer.findByIdAndDelete(req.params.id);
    if (!cust) return res.status(404).json({ success: false, message: 'Customer not found.' });
    logActivity('customer_delete', req.user.name, req.user.role, `${req.user.name} deleted customer ${cust.name}`, { customer: cust.name });
    sync('customers', 'delete', { _id: cust._id });
    res.json({ success: true, message: 'Customer deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/customers  — wipe all (Super Admin only)
router.delete('/', requireRole('Super Admin'), async (req, res) => {
  try {
    const count = await Customer.countDocuments({});
    await Customer.deleteMany({});
    logActivity('customer_delete', req.user.name, req.user.role, `${req.user.name} wiped ALL ${count} customers from the system.`, { count });
    ['Super Admin', 'Branch Manager'].forEach((role) => {
      createNotification({
        recipientRole: role,
        type: 'customer_delete',
        title: 'ALL Customers Wiped',
        body: `${req.user.name} deleted all ${count} customer records from the system.`,
      });
    });
    res.json({ success: true, message: 'All customers deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/customers/:id/create-login — create login credentials for an existing customer
router.post('/:id/create-login', requireRole('Super Admin', 'Branch Manager'), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password are required.' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

    const cust = await Customer.findById(req.params.id);
    if (!cust) return res.status(404).json({ success: false, message: 'Customer not found.' });

    const alreadyLinked = await User.findOne({ customerId: cust._id });
    if (alreadyLinked) return res.status(400).json({ success: false, message: 'This customer already has a login account.' });

    const clean = username.toLowerCase().trim();
    const clash = await User.findOne({ username: clean });
    if (clash) return res.status(400).json({ success: false, message: `Username "${clean}" is already taken.` });

    await User.create({ name: cust.name, username: clean, password, role: 'Customer', phone: cust.phone || '', customerId: cust._id });
    logActivity('customer_login_created', req.user.name, req.user.role, `${req.user.name} created login for customer ${cust.name} (username: ${clean})`, { customer: cust.name, username: clean });
    res.json({ success: true, message: 'Login created.', credentials: { username: clean, password } });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/customers/:id/assign — managers reassign to anyone; field collectors self-assign
router.patch('/:id/assign', requireRole('Super Admin', 'Branch Manager', 'Field Collector'), async (req, res) => {
  try {
    let employeeId = req.body.employeeId;
    // Field Collectors can only assign customers to themselves
    if (req.user.role === 'Field Collector') {
      const me = await Employee.findOne({ userId: req.user._id }).select('_id');
      if (!me) return res.status(400).json({ success: false, message: 'No employee profile linked to your account.' });
      employeeId = me._id;
    }
    const cust = await Customer.findByIdAndUpdate(req.params.id, { assignedEmployee: employeeId }, { new: true }).populate('assignedEmployee', 'name');
    if (!cust) return res.status(404).json({ success: false, message: 'Customer not found.' });
    logActivity('customer_assign', req.user.name, req.user.role, `${req.user.name} assigned customer ${cust.name} to ${(cust.assignedEmployee && cust.assignedEmployee.name) || 'an employee'}`, { customer: cust.name });
    sync('customers', 'update', cust); // real-time update across devices
    res.json({ success: true, data: cust, message: 'Customer assigned.' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
