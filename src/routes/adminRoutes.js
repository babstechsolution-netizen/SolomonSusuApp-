const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const Backup = require('../models/Backup');
const Setting = require('../models/Setting');
const { protect, requireRole } = require('../middleware/auth');
const { createBackup, BACKUP_COLLECTIONS } = require('../utils/backup');
const { startBackupScheduler } = require('../scheduler');

const router = express.Router();
router.use(protect, requireRole('Super Admin'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// POST /api/admin/backup — create manual backup
router.post('/backup', async (req, res) => {
  try {
    const backup = await createBackup('manual', req.user.name || req.user.username);
    const obj = backup.toObject();
    delete obj.data;
    res.json({ success: true, data: obj, message: 'Backup created successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/backups — list backups
router.get('/backups', async (req, res) => {
  try {
    const backups = await Backup.find().select('-data').sort({ createdAt: -1 });
    res.json({ success: true, data: backups });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/backup/:id/download — download as JSON file
router.get('/backup/:id/download', async (req, res) => {
  try {
    const backup = await Backup.findById(req.params.id);
    if (!backup) return res.status(404).json({ success: false, message: 'Backup not found.' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${backup.name}.json"`);
    res.send(backup.data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/restore/:id — restore from stored backup
router.post('/restore/:id', async (req, res) => {
  try {
    const { wipe = false } = req.body;
    const backup = await Backup.findById(req.params.id);
    if (!backup) return res.status(404).json({ success: false, message: 'Backup not found.' });

    const { collections } = JSON.parse(backup.data);
    const results = {};

    for (const colName of BACKUP_COLLECTIONS) {
      const docs = collections[colName] || [];
      const col = mongoose.connection.collection(colName);
      if (wipe) await col.deleteMany({});
      if (docs.length > 0) {
        const cleaned = docs.map(d => ({ ...d, _id: new mongoose.Types.ObjectId(d._id) }));
        try {
          const r = await col.insertMany(cleaned, { ordered: false });
          results[colName] = r.insertedCount;
        } catch (e) {
          results[colName] = e.result?.nInserted || 0;
        }
      } else {
        results[colName] = 0;
      }
    }

    res.json({ success: true, message: 'Restore completed.', results });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/restore/upload — restore from uploaded JSON file
router.post('/restore/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
    const { wipe = false } = req.body;

    let parsed;
    try { parsed = JSON.parse(req.file.buffer.toString('utf8')); }
    catch (e) { return res.status(400).json({ success: false, message: 'Invalid JSON file.' }); }

    if (!parsed.collections) return res.status(400).json({ success: false, message: 'Invalid backup format.' });

    const results = {};
    for (const colName of BACKUP_COLLECTIONS) {
      const docs = parsed.collections[colName] || [];
      const col = mongoose.connection.collection(colName);
      if (wipe) await col.deleteMany({});
      if (docs.length > 0) {
        const cleaned = docs.map(d => ({ ...d, _id: new mongoose.Types.ObjectId(d._id) }));
        try {
          const r = await col.insertMany(cleaned, { ordered: false });
          results[colName] = r.insertedCount;
        } catch (e) {
          results[colName] = e.result?.nInserted || 0;
        }
      } else {
        results[colName] = 0;
      }
    }

    res.json({ success: true, message: 'Restore from file completed.', results });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/admin/backup/:id
router.delete('/backup/:id', async (req, res) => {
  try {
    await Backup.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Backup deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/settings
router.get('/settings', async (req, res) => {
  try {
    const settings = await Setting.find();
    const result = {};
    settings.forEach(s => { result[s.key] = s.value; });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/admin/settings — update one or more settings
router.patch('/settings', async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await Setting.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
    }
    // Restart scheduler if backup schedule changed
    if (req.body.backupSchedule !== undefined) {
      startBackupScheduler().catch(() => {});
    }
    res.json({ success: true, message: 'Settings saved.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
