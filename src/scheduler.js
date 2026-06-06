const cron = require('node-cron');
const Setting = require('./models/Setting');
const { createBackup } = require('./utils/backup');

let currentTask = null;

const FREQ_TO_CRON = {
  hourly: '0 * * * *',
  daily:  '0 2 * * *',
  weekly: '0 2 * * 0',
};

async function startBackupScheduler() {
  try {
    if (currentTask) { currentTask.stop(); currentTask = null; }

    const setting = await Setting.findOne({ key: 'backupSchedule' });
    if (!setting?.value?.enabled) return;

    const expr = FREQ_TO_CRON[setting.value.frequency] || FREQ_TO_CRON.daily;

    currentTask = cron.schedule(expr, async () => {
      try {
        await createBackup('scheduled', 'system');
        console.log('[scheduler] Scheduled backup completed.');
      } catch (e) {
        console.error('[scheduler] Backup failed:', e.message);
      }
    });

    console.log(`[scheduler] Backup scheduled: ${setting.value.frequency}`);
  } catch (err) {
    console.error('[scheduler] Init error:', err.message);
  }
}

module.exports = { startBackupScheduler };
