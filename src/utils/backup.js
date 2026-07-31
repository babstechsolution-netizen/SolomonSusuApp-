const mongoose = require('mongoose');
const Backup = require('../models/Backup');
const Setting = require('../models/Setting');

const BACKUP_COLLECTIONS = ['users', 'employees', 'customers', 'transactions', 'loans'];
const MAX_BACKUPS = 20;

async function createBackup(type = 'manual', createdBy = 'system') {
  const collections = {};
  const recordCounts = {};

  for (const col of BACKUP_COLLECTIONS) {
    const docs = await mongoose.connection.collection(col).find({}).toArray();
    collections[col] = JSON.parse(JSON.stringify(docs));
    recordCounts[col] = docs.length;
  }

  const now = new Date();
  const name = `backup_${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const dataStr = JSON.stringify({ version: '1.0', timestamp: now.toISOString(), collections });

  const backup = await Backup.create({
    name,
    data: dataStr,
    sizeBytes: Buffer.byteLength(dataStr, 'utf8'),
    recordCounts,
    type,
    createdBy,
  });

  // Prune old backups
  const count = await Backup.countDocuments();
  if (count > MAX_BACKUPS) {
    const oldest = await Backup.find().sort({ createdAt: 1 }).limit(count - MAX_BACKUPS).select('_id');
    await Backup.deleteMany({ _id: { $in: oldest.map(b => b._id) } });
  }

  // Upload to Google Drive if configured
  await tryGoogleDriveUpload(backup.name, dataStr);

  return backup;
}

async function tryGoogleDriveUpload(name, dataStr) {
  try {
    const setting = await Setting.findOne({ key: 'googleDrive' });
    if (!setting?.value?.enabled || !setting.value.serviceAccountKey || !setting.value.folderId) return;

    // Use the lightweight @googleapis/drive package instead of the full googleapis
    // meta-package — same Drive API, far smaller install (much faster deploys).
    const { drive: driveApi, auth: googleAuth } = require('@googleapis/drive');
    const { Readable } = require('stream');

    const credentials = JSON.parse(setting.value.serviceAccountKey);
    const auth = new googleAuth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });

    const drive = driveApi({ version: 'v3', auth });
    const stream = Readable.from([dataStr]);

    await drive.files.create({
      requestBody: { name: `${name}.json`, parents: [setting.value.folderId] },
      media: { mimeType: 'application/json', body: stream },
    });

    console.log(`[backup] Uploaded to Google Drive: ${name}.json`);
  } catch (e) {
    console.error('[backup] Google Drive upload failed:', e.message);
  }
}

module.exports = { createBackup, BACKUP_COLLECTIONS };
