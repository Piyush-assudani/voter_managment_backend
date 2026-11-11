#!/usr/bin/env node
/**
 * Import perfected Ward 1 & Ward 2 of भयाडी करमूका for सविता सतबीर कसाना
 * Client email: client_013@vijaysetu.io
 * Organization ID: tenant_9846807f-068a-49d7-aa79-ca692a80e62f
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const cache = require('../lib/cache');

const JSON_FILE = path.resolve(__dirname, '../data/savita_wards_1_2_perfect.json');
const TENANT_ID = 'tenant_9846807f-068a-49d7-aa79-ca692a80e62f';

async function run() {
  if (!fs.existsSync(JSON_FILE)) {
    console.error(`Error: JSON file not found at ${JSON_FILE}. Run perfect_savita_wards_1_2.py first.`);
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.');

  const Voter = mongoose.model('Voter', new mongoose.Schema({}, { strict: false }));
  const Organization = mongoose.model('Organization', new mongoose.Schema({ _id: String }, { strict: false }));

  const raw = fs.readFileSync(JSON_FILE, 'utf8');
  const voters = JSON.parse(raw);
  console.log(`Loaded ${voters.length} perfected voters from JSON (Ward 1 & Ward 2).`);

  // 1. Delete existing voters for Savita's organization to show only the 2 wards requested
  const delRes = await Voter.deleteMany({ organizationId: TENANT_ID });
  console.log(`Deleted ${delRes.deletedCount} old records for ${TENANT_ID}.`);

  // 2. Prepare documents for bulk insert
  const docs = voters.map((v, i) => ({
    organizationId: TENANT_ID,
    epic: v.epic,
    epicNo: v.epic,
    name: v.name_hi,
    nameHi: v.name_hi,
    nameEn: v.name_en,
    relativeName: v.relative_name_hi,
    relativeNameHi: v.relative_name_hi,
    relativeNameEn: v.relative_name_en,
    relationType: v.relation || 'पिता',
    houseNo: String(v.house_no || '-'),
    houseNoHi: String(v.house_no || '-'),
    age: Number(v.age) || 30,
    gender: v.gender || 'पुरुष',
    wardNo: String(v.ward),
    sectionNo: String(v.part || '1'),
    partNo: String(v.part || '1'),
    serialNo: Number(v.ward_serial) || (i + 1),
    panchayat: v.panchayat,
    village: v.village_hi,
    villageName: v.village_hi,
    villageNameHi: v.village_hi,
    caste: v.caste || '',
    phone: v.mobile || '',
    mobileNo: v.mobile || '',
    isDeleted: (v.status || '').includes('विलोपित'),
    status: v.status || 'Active',
    source: 'pdf_perfect_deeg_compiler',
    createdAt: new Date(),
    updatedAt: new Date()
  }));

  console.log(`Inserting ${docs.length} verified voter records...`);
  await Voter.insertMany(docs, { ordered: false });
  console.log(`Inserted ${docs.length} voter records successfully.`);

  // 3. Update Organization to restrict visible Wards strictly to ['1', '2']
  const orgRes = await Organization.updateOne(
    { _id: TENANT_ID },
    {
      $set: {
        panchayats: ['भयाडी करमूका'],
        allowedPanchayats: ['भयाडी करमूका'],
        wards: ['1', '2'],
        allowedWards: ['1', '2'],
        totalVoters: docs.length,
        voterCount: docs.length,
        candidateName: 'सविता सतबीर कसाना',
        'slipConfig.candidateName': 'सविता सतबीर कसाना',
        district: 'डीग',
        ulbPanchayatSamiti: 'नगर',
        updatedAt: new Date()
      }
    }
  );
  console.log(`Updated Organization ${TENANT_ID} metadata:`, orgRes);

  // 4. Invalidate all backend cache
  try {
    cache.flushAll();
    console.log('Cache flushed successfully.');
  } catch (err) {
    console.log('Cache flush note:', err.message);
  }

  console.log(`\nSUCCESS: Only Ward 1 & Ward 2 (total ${docs.length} voters) are now active and visible for सविता सतबीर कसाना (${TENANT_ID}).`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
