const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);
const {
  Organization,
  User,
  Voter,
  SlipDispatch,
  Lead,
  LearnedDictionary,
  SystemSetting,
  CampaignTemplate
} = require('../models');

const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.resolve(__dirname, '../backups');
const MAX_BACKUPS_TO_KEEP = Number.parseInt(process.env.MAX_DB_BACKUPS || '14', 10) || 14;

const COLLECTION_MAP = [
  ['organizations', Organization],
  ['users', User],
  ['voters', Voter],
  ['slipDispatches', SlipDispatch],
  ['leads', Lead],
  ['learnedDictionaries', LearnedDictionary],
  ['systemSettings', SystemSetting],
  ['campaignTemplates', CampaignTemplate]
];

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function sanitizeBackupFilename(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const base = path.basename(filename.trim());
  if (!/^[a-zA-Z0-9._-]+\.json\.gz$/.test(base)) return null;
  return base;
}

function getBackupFilePath(filename) {
  const safe = sanitizeBackupFilename(filename);
  if (!safe) return null;
  const resolved = path.resolve(BACKUP_DIR, safe);
  if (!resolved.startsWith(BACKUP_DIR + path.sep)) return null;
  return resolved;
}

/**
 * Create a full gzip-compressed JSON snapshot of all MongoDB collections atomically.
 * Never overwrites or truncates previous valid backups on failure.
 */
async function createDatabaseBackup({ label = 'scheduled', triggeredBy = 'system' } = {}) {
  ensureBackupDir();

  const safeLabel = String(label || 'manual').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || 'manual';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `vijaysetu-backup-${timestamp}-${safeLabel}.json.gz`;
  const targetPath = path.join(BACKUP_DIR, filename);
  const tmpPath = `${targetPath}.tmp`;
  const metaPath = `${targetPath}.meta.json`;

  const counts = {};
  const collections = {};

  for (const [key, Model] of COLLECTION_MAP) {
    if (!Model) {
      counts[key] = 0;
      collections[key] = [];
      continue;
    }
    const docs = await Model.find({}).lean();
    counts[key] = docs.length;
    collections[key] = docs;
  }

  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    label: safeLabel,
    triggeredBy: String(triggeredBy || 'system').slice(0, 80),
    counts,
    collections
  };

  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
  const sha256 = crypto.createHash('sha256').update(jsonBuffer).digest('hex');
  const compressed = await gzipAsync(jsonBuffer, { level: 6 });

  await fs.promises.writeFile(tmpPath, compressed);
  await fs.promises.rename(tmpPath, targetPath);

  const meta = {
    filename,
    createdAt: payload.createdAt,
    label: safeLabel,
    triggeredBy: payload.triggeredBy,
    sizeBytes: compressed.length,
    uncompressedBytes: jsonBuffer.length,
    sha256,
    counts
  };
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));

  pruneOldBackups();

  console.log(`💾 [BackupService] Snapshot saved: ${filename} (${(compressed.length / 1024).toFixed(1)} KB)`);
  return meta;
}

function pruneOldBackups() {
  try {
    const files = listBackups();
    if (files.length <= MAX_BACKUPS_TO_KEEP) return;
    const toRemove = files.slice(MAX_BACKUPS_TO_KEEP);
    for (const item of toRemove) {
      const gzPath = getBackupFilePath(item.filename);
      if (gzPath && fs.existsSync(gzPath)) fs.unlinkSync(gzPath);
      const mPath = gzPath ? `${gzPath}.meta.json` : null;
      if (mPath && fs.existsSync(mPath)) fs.unlinkSync(mPath);
    }
  } catch (err) {
    console.warn('[BackupService] Retention cleanup warning:', err.message);
  }
}

function listBackups() {
  ensureBackupDir();
  const entries = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json.gz'));
  const results = [];

  for (const fname of entries) {
    const gzPath = path.join(BACKUP_DIR, fname);
    const metaPath = `${gzPath}.meta.json`;
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        results.push(meta);
      } else {
        const stat = fs.statSync(gzPath);
        results.push({
          filename: fname,
          createdAt: stat.mtime.toISOString(),
          label: 'legacy',
          sizeBytes: stat.size,
          counts: null
        });
      }
    } catch {
      // skip corrupt manifest
    }
  }

  return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function verifyBackupIntegrity(filename) {
  const gzPath = getBackupFilePath(filename);
  if (!gzPath || !fs.existsSync(gzPath)) {
    throw new Error('बैकअप फ़ाइल नहीं मिली।');
  }
  const compressed = fs.readFileSync(gzPath);
  const decompressed = zlib.gunzipSync(compressed);
  const actualHash = crypto.createHash('sha256').update(decompressed).digest('hex');
  const parsed = JSON.parse(decompressed.toString('utf8'));

  const metaPath = `${gzPath}.meta.json`;
  let expectedHash = null;
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expectedHash = meta.sha256 || null;
  }

  const hashMatch = !expectedHash || expectedHash === actualHash;
  const computedCounts = {};
  for (const [key] of COLLECTION_MAP) {
    computedCounts[key] = Array.isArray(parsed.collections?.[key]) ? parsed.collections[key].length : 0;
  }

  return {
    ok: hashMatch && Boolean(parsed.collections),
    filename: path.basename(gzPath),
    sha256: actualHash,
    expectedHash,
    createdAt: parsed.createdAt,
    counts: computedCounts
  };
}

/**
 * Restore a verified backup snapshot safely using bulkWrite upserts
 * (preserving existing records if clearExisting=false, or clean replacement after verifying payload).
 */
async function restoreDatabaseBackup(filename, { clearExisting = false } = {}) {
  const verification = verifyBackupIntegrity(filename);
  if (!verification.ok) {
    throw new Error('बैकअप checksum सत्यापन विफल रहा। डेटा बहाल नहीं किया गया।');
  }

  const gzPath = getBackupFilePath(filename);
  const rawCompressed = await fs.promises.readFile(gzPath);
  const decompressed = await gunzipAsync(rawCompressed);
  const payload = JSON.parse(decompressed.toString('utf8'));

  const restoredCounts = {};
  for (const [key, Model] of COLLECTION_MAP) {
    const docs = payload.collections?.[key];
    if (!Model || !Array.isArray(docs)) {
      restoredCounts[key] = 0;
      continue;
    }

    if (clearExisting) {
      await Model.deleteMany({});
    }

    if (docs.length > 0) {
      const ops = docs.map((doc) => ({
        replaceOne: {
          filter: { _id: doc._id },
          replacement: doc,
          upsert: true
        }
      }));
      const CHUNK = 500;
      for (let i = 0; i < ops.length; i += CHUNK) {
        await Model.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
      }
    }
    restoredCounts[key] = docs.length;
  }

  return {
    ok: true,
    filename: verification.filename,
    restoredCounts
  };
}

module.exports = {
  BACKUP_DIR,
  createDatabaseBackup,
  listBackups,
  getBackupFilePath,
  verifyBackupIntegrity,
  restoreDatabaseBackup
};

