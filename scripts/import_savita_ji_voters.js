#!/usr/bin/env node
/**
 * Import all 70 Wards of सविता सतबीर कसाना into MongoDB
 * Organization ID: tenant_9846807f-068a-49d7-aa79-ca692a80e62f
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const cache = require('../lib/cache');

const JSON_FILE = path.resolve(__dirname, '../data/savita_ji_all_voters.json');
const TENANT_ID = 'tenant_9846807f-068a-49d7-aa79-ca692a80e62f';

async function run() {
  if (!fs.existsSync(JSON_FILE)) {
    console.error(`Error: JSON file not found at ${JSON_FILE}. Run extract_savita_ji_constituency.py first.`);
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.');

  const Voter = mongoose.model('Voter', new mongoose.Schema({}, { strict: false }));
  const Organization = mongoose.model('Organization', new mongoose.Schema({}, { strict: false }));

  const raw = fs.readFileSync(JSON_FILE, 'utf8');
  const voters = JSON.parse(raw);
  console.log(`Loaded ${voters.length} voters from JSON.`);

  // 1. Delete existing voters for this tenant to allow clean replacement
  const delRes = await Voter.deleteMany({ organizationId: TENANT_ID });
  console.log(`Deleted ${delRes.deletedCount} old records for ${TENANT_ID}.`);

  // 2. Prepare documents for bulk insert
  const docs = voters.map((v, i) => ({
    organizationId: TENANT_ID,
    epicNo: v.epic || `SAVITA_${v.ward}_${v.ward_serial}`,
    name: v.name_hi,
    nameEn: v.name_en,
    relativeName: v.relative_name_hi,
    relativeNameEn: v.relative_name_en,
    relationType: v.relation || 'पिता',
    houseNo: String(v.house_no || '-'),
    age: Number(v.age) || 30,
    gender: v.gender || 'पुरुष',
    wardNo: String(v.ward),
    sectionNo: String(v.part || '1'),
    serialNo: Number(v.ward_serial) || (i + 1),
    panchayat: v.panchayat,
    village: v.village_hi,
    caste: v.caste || '',
    phone: v.mobile || '',
    isDeleted: (v.status || '').includes('विलोपित'),
    status: v.status || 'सक्रिय',
    source: 'pdf_perfect_deeg_compiler',
    createdAt: new Date(),
    updatedAt: new Date()
  }));

  console.log(`Inserting ${docs.length} voter records in chunks of 2,000...`);
  const CHUNK_SIZE = 2000;
  for (let c = 0; c < docs.length; c += CHUNK_SIZE) {
    const chunk = docs.slice(c, c + CHUNK_SIZE);
    await Voter.insertMany(chunk, { ordered: false });
    console.log(`  Inserted ${Math.min(c + CHUNK_SIZE, docs.length)} / ${docs.length}`);
  }

  // 3. Update Organization with accurate Panchayats and Wards
  const panchayats = [
    'भयाडी करमूका', 'चूल्हेरा', 'गढ़ी मेवात', 'गुहाना',
    'जटेरी', 'खोह', 'निगोही', 'पसोपा'
  ];
  const distinctWards = Array.from(new Set(voters.map(v => String(v.ward)))).sort((a, b) => Number(a) - Number(b));

  const orgRes = await Organization.updateOne(
    { organizationId: TENANT_ID },
    {
      $set: {
        panchayats: panchayats,
        wards: distinctWards,
        totalVoters: docs.length,
        voterCount: docs.length,
        updatedAt: new Date()
      }
    }
  );
  console.log(`Updated organization ${TENANT_ID} metadata:`, orgRes);

  // 4. Invalidate all backend cache
  try {
    cache.flushAll();
    console.log('Cache flushed successfully.');
  } catch (err) {
    console.log('Cache flush note:', err.message);
  }

  console.log(`All ${docs.length} voters imported successfully for सविता सतबीर कसाना!`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
