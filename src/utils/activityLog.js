const ActivityLog = require('../models/ActivityLog');

// Safe wrapper — logging must never crash the main request
async function logActivity(type, actor, actorRole, action, details = {}) {
  try {
    await ActivityLog.create({ type, actor, actorRole, action, details });
  } catch (e) {
    console.error('[activityLog]', e.message);
  }
}

module.exports = { logActivity };
