/**
 * Fix tenant_92cc904f-52df-465c-8249-4e02c8d81d2d (छगन रावताराम हुड्डा / ग्राम पंचायत खेड़)
 * Replace all corrupted records with the authentic 2,035 voters from sheet 'खेड़'
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const path = require('path');
const crypto = require('crypto');
const cache = require('../lib/cache');
const { Voter, Organization } = require('../models/index');

const EXCEL_PATH = path.resolve(__dirname, '../../Master_Voters_Panchayat_Samiti_22.xlsx');
const KHED_TENANT_ID = 'tenant_92cc904f-52df-465c-8249-4e02c8d81d2d';

async function fixKhed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB.');

  const org = await Organization.findById(KHED_TENANT_ID);
  if (!org) {
    console.error('Khed org not found!');
    process.exit(1);
  }
  console.log(`Found org: ${org.name} (${org._id})`);

  // Load Excel sheet 'खेड़'
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(EXCEL_PATH);
  const worksheet = workbook.getWorksheet('खेड़');
  if (!worksheet) {
    console.error("Sheet 'खेड़' not found!");
    process.exit(1);
  }

  const voters = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Header

    const epic = String(row.getCell(2).value || '').trim();
    const panchayat = String(row.getCell(3).value || 'खेड़').trim();
    const wardNo = String(row.getCell(4).value || '1').trim();
    const partNo = String(row.getCell(5).value || '1').trim();
    const serialNo = parseInt(row.getCell(6).value, 10);
    const nameHi = String(row.getCell(7).value || '').trim();
    const nameEn = String(row.getCell(8).value || '').trim();
    const relationType = String(row.getCell(9).value || 'पिता').trim();
    const relativeNameHi = String(row.getCell(10).value || '').trim();
    const relativeNameEn = String(row.getCell(11).value || '').trim();
    const houseNo = String(row.getCell(12).value || '-').trim();
    const age = parseInt(row.getCell(13).value, 10) || null;
    const gender = String(row.getCell(14).value || 'पुरुष').trim();
    const caste = String(row.getCell(15).value || '').trim();
    const mobileNo = String(row.getCell(16).value || '').trim();
    const villageName = String(row.getCell(17).value || '').trim();
    const status = String(row.getCell(18).value || 'Active').trim() === 'विलोपित' ? 'Deleted' : 'Active';

    if (!nameHi) return;

    voters.push({
      _id: `voter_${crypto.randomUUID()}`,
      organizationId: KHED_TENANT_ID,
      epic,
      wardNo,
      panchayat,
      panchayatHi: panchayat,
      partNo,
      serialNo,
      nameHi,
      nameEn,
      relationType,
      relativeNameHi,
      relativeNameEn,
      houseNo,
      houseNoHi: houseNo,
      age,
      gender,
      caste,
      mobileNo,
      villageName,
      villageNameHi: villageName,
      status,
      voted: false,
      supportStatus: 'unmarked'
    });
  });

  console.log(`Parsed ${voters.length} clean voters for Kheṛ.`);

  // 1. Delete corrupted records
  const delRes = await Voter.deleteMany({ organizationId: KHED_TENANT_ID });
  console.log(`Deleted ${delRes.deletedCount} corrupted records from ${KHED_TENANT_ID}.`);

  // 2. Insert clean records
  const BATCH_SIZE = 500;
  let inserted = 0;
  for (let i = 0; i < voters.length; i += BATCH_SIZE) {
    const chunk = voters.slice(i, i + BATCH_SIZE);
    await Voter.insertMany(chunk, { ordered: false });
    inserted += chunk.length;
    console.log(`Inserted ${inserted} / ${voters.length}...`);
  }

  // 3. Update Org wards and allowedWards
  const cleanWards = ['1', '2', '3', '4', '5', '6', '7'];
  await Organization.findByIdAndUpdate(KHED_TENANT_ID, {
    wards: cleanWards,
    allowedWards: cleanWards,
    ulbWardGramPanchayat: 'ग्राम पंचायत खेड़'
  });
  console.log(`Updated Kheṛ organization wards to: ${cleanWards.join(', ')}`);

  // 4. Invalidate all cache
  cache.flushAll();
  console.log('Cache flushed successfully.');

  process.exit(0);
}

fixKhed().catch((err) => {
  console.error('Error fixing Khed:', err);
  process.exit(1);
});
