const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const Customer = require('../models/Customer');
const { protect, requireRole } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

// POST /api/customers/import — import from Excel file
router.post('/import', requireRole('Super Admin', 'Branch Manager'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) return res.status(400).json({ success: false, message: 'Excel file is empty.' });

    const colors = ['#ec4899', '#06b6d4', '#f59e0b', '#8b5cf6', '#3b82f6', '#10b981', '#ef4444', '#14b8a6'];
    const valid = [];
    const errors = [];

    rows.forEach((row, i) => {
      const name = String(row.name || row.Name || row.NAME || '').trim();
      const phone = String(row.phone || row.Phone || row.PHONE || '').trim();
      if (!name || !phone) { errors.push(`Row ${i + 2}: name and phone are required`); return; }
      valid.push({
        name,
        phone,
        business: String(row.business || row.Business || row.BUSINESS || '').trim(),
        location: String(row.location || row.Location || row.LOCATION || '').trim(),
        color: colors[i % colors.length],
        status: 'active',
      });
    });

    if (!valid.length) return res.status(400).json({ success: false, message: 'No valid rows found.', errors });

    const created = await Customer.insertMany(valid, { ordered: false });
    res.json({ success: true, message: `${created.length} customer(s) imported.`, data: created, errors });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
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
