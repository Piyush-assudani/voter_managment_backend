#!/usr/bin/env node
/**
 * Manual / CLI Database Backup Utility
 * Usage:
 *   npm run backup
 *   node scripts/backup_db.js [label]
 */
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { connectDB, stopDB } = require('../db');
const { createDatabaseBackup, verifyBackupIntegrity } = require('../lib/backupService');

async function main() {
  const label = process.argv[2] || 'cli-manual';
  try {
    await connectDB();
    const meta = await createDatabaseBackup({ label, triggeredBy: 'cli' });
    const verification = verifyBackupIntegrity(meta.filename);
    if (!verification.ok) {
      throw new Error('Backup checksum verification failed immediately after write!');
    }
    console.log('✅ Verified database backup created:', JSON.stringify(meta, null, 2));
  } finally {
    await stopDB().catch(() => {});
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect().catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error('❌ Database backup failed:', err.message);
  process.exit(1);
});

