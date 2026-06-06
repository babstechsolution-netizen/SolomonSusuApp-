const express = require('express');
const ActivityLog = require('../models/ActivityLog');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(protect, requireRole('Super Admin'));

// GET /api/activity — paginated activity log
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const page  = parseInt(req.query.page)  || 1;
    const skip  = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      ActivityLog.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      ActivityLog.countDocuments(),
    ]);

    res.json({ success: true, data: logs, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/activity — clear all logs
router.delete('/', async (req, res) => {
  try {
    await ActivityLog.deleteMany({});
    res.json({ success: true, message: 'Activity log cleared.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
