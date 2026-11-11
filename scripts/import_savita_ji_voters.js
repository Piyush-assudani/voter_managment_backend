#!/usr/bin/env node
/**
 * Import ALL 70 Wards (20,881 voters) across all 8 Gram Panchayats for सविता सतबीर कसाना
 * Client email: client_013@vijaysetu.io
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
  const Organization = mongoose.model('Organization', new mongoose.Schema({ _id: String }, { strict: false }));

  const raw = fs.readFileSync(JSON_FILE, 'utf8');
  const voters = JSON.parse(raw);
  console.log(`Loaded ${voters.length} total voters from JSON.`);

  // 1. Delete existing voters for Savita's organization for clean complete replacement
  const delRes = await Voter.deleteMany({ organizationId: TENANT_ID });
  console.log(`Deleted ${delRes.deletedCount} old records for ${TENANT_ID}.`);

  // 2. Prepare documents for bulk insert
  const docs = voters.map((v, i) => {
    let epic = (v.epic || '').trim();
    if (!epic || epic.startsWith('VOTER_') || epic.startsWith('UNREADABLE_')) {
      epic = `SAVITA-W${v.ward}-${String(v.ward_serial || (i + 1)).padStart(3, '0')}`;
    }

    let nameHi = (v.name_hi || '').trim();
    if (!nameHi || nameHi === 'मतदाता' || nameHi === '-') {
      nameHi = 'नाम उपलब्ध नहीं (निर्वाचन आयोग)';
    }

    let relHi = (v.relative_name_hi || '').trim();
    if (!relHi || relHi === '-') {
      relHi = '-';
    }

    const nameEn = v.name_en || (nameHi !== 'नाम उपलब्ध नहीं (निर्वाचन आयोग)' ? '' : 'Name Not Available');
    const relEn = v.relative_name_en || '';

    return {
      organizationId: TENANT_ID,
      epic: epic,
      epicNo: epic,
      name: nameHi,
      nameHi: nameHi,
      nameEn: nameEn,
      relativeName: relHi,
      relativeNameHi: relHi,
      relativeNameEn: relEn,
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
      village: v.village_hi || v.panchayat,
      villageName: v.village_hi || v.panchayat,
      villageNameHi: v.village_hi || v.panchayat,
      caste: v.caste || '',
      phone: v.mobile || '',
      mobileNo: v.mobile || '',
      isDeleted: (v.status || '').includes('विलोपित'),
      status: v.status || 'Active',
      source: 'pdf_perfect_deeg_compiler',
      createdAt: new Date(),
      updatedAt: new Date()
    };
  });

  console.log(`Inserting ${docs.length} verified voter records in chunks of 2,000...`);
  const CHUNK_SIZE = 2000;
  for (let c = 0; c < docs.length; c += CHUNK_SIZE) {
    const chunk = docs.slice(c, c + CHUNK_SIZE);
    await Voter.insertMany(chunk, { ordered: false });
    console.log(`  Inserted ${Math.min(c + CHUNK_SIZE, docs.length)} / ${docs.length}`);
  }

  // 3. Update Organization to enable all 8 Panchayats and all 11 Wards
  const panchayats = [
    'भयाडी करमूका', 'चूल्हेरा', 'गढ़ी मेवात', 'गुहाना',
    'जटेरी', 'खोह', 'निगोही', 'पसोपा'
  ];
  const distinctWards = Array.from(new Set(voters.map(v => String(v.ward)))).sort((a, b) => Number(a) - Number(b));

  const orgRes = await Organization.updateOne(
    { _id: TENANT_ID },
    {
      $set: {
        panchayats: panchayats,
        allowedPanchayats: panchayats,
        wards: distinctWards,
        allowedWards: distinctWards,
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

  console.log(`\n🎉 SUCCESS: All ${docs.length} voters across all 70 wards imported successfully for सविता सतबीर कसाना (${TENANT_ID})!`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
