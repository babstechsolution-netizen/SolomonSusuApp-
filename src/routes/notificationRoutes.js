const express = require('express');
const Notification = require('../models/Notification');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

// Notifications relevant to the requesting user: addressed to them personally,
// to their role, or broadcast to everyone (no recipient set).
function scopeFor(user) {
  return {
    $or: [
      { recipientUser: user._id },
      { recipientRole: user.role },
      { recipientUser: null, recipientRole: null },
    ],
  };
}

// GET /api/notifications?limit=50&page=1
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const filter = scopeFor(req.user);

    const [data, unread] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Notification.countDocuments({ ...filter, read: false }),
    ]);

    res.json({ success: true, data, unread });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/notifications/read-all — mark all of mine as read
router.patch('/read-all', async (req, res) => {
  try {
    await Notification.updateMany({ ...scopeFor(req.user), read: false }, { read: true });
    res.json({ success: true, message: 'All notifications marked read.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/notifications/:id/read — mark one as read
router.patch('/:id/read', async (req, res) => {
  try {
    const n = await Notification.findByIdAndUpdate(req.params.id, { read: true }, { new: true });
    if (!n) return res.status(404).json({ success: false, message: 'Notification not found.' });
    res.json({ success: true, data: n });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
