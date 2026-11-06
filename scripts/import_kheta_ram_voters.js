const path = require('path');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { predictCaste } = require('../lib/fuzzyNameMatcher');
const { groupVotersIntoFamilies } = require('../lib/familyService');

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI missing from .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB.');

  const orgsColl = mongoose.connection.db.collection('organizations');
  const votersColl = mongoose.connection.db.collection('voters');

  const khetaOrg = await orgsColl.findOne({ name: /Kheta Ram/i });
  if (!khetaOrg) {
    console.error('Kheta Ram organization not found!');
    process.exit(1);
  }

  const orgId = String(khetaOrg._id);
  console.log(`Found Kheta Ram org with ID: ${orgId}`);

  const filePath = path.join(__dirname, '../../Maulasar_Voters.xlsx');
  console.log(`Loading ${filePath}...`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];

  const voters = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Header

    const wardVal = String(row.getCell(2).value || '1').trim();
    const serialNo = parseInt(row.getCell(3).value, 10);
    const epic = String(row.getCell(4).value || '').trim();
    const nameHi = String(row.getCell(5).value || '').trim();
    const relationType = String(row.getCell(6).value || 'पिता').trim();
    const relativeNameHi = String(row.getCell(7).value || '').trim();
    let houseNo = String(row.getCell(8).value || '-').trim();
    if (houseNo === '0' || houseNo === '00') houseNo = '-';
    const rawAge = row.getCell(9).value;
    const age = rawAge ? parseInt(rawAge, 10) : null;
    let gender = String(row.getCell(10).value || '').trim();

    if (gender !== 'पुरुष' && gender !== 'स्त्री') {
      gender = (relationType === 'पति') ? 'स्त्री' : 'पुरुष';
    }

    if (serialNo && nameHi) {
      voters.push({
        serialNo,
        epic: epic || `VOTER_W${wardVal}_P1_${serialNo}`,
        nameHi,
        nameEn: nameHi,
        relativeNameHi: relativeNameHi !== '-' ? relativeNameHi : '',
        relativeNameEn: relativeNameHi !== '-' ? relativeNameHi : '',
        relationType,
        houseNo,
        age,
        gender,
        wardNo: wardVal,
        partNo: '1',
        status: 'Active',
        organizationId: orgId,
        panchayat: 'मौलासर',
        panchayatHi: 'मौलासर',
        villageName: 'मौलासर',
        villageNameHi: 'मौलासर'
      });
    }
  });

  console.log(`Parsed ${voters.length} total voters for Kheta Ram.`);

  // Group into families
  const { families, voterFamilyMap } = groupVotersIntoFamilies(voters);
  console.log(`Grouped into ${families.length} families across all wards.`);

  // Clear any partial/stale records for Kheta Ram before full fresh import
  const deletedRes = await votersColl.deleteMany({ organizationId: orgId });
  console.log(`Cleared ${deletedRes.deletedCount} old records for Kheta Ram.`);

  // Bulk insert in chunks of 1000
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < voters.length; i += CHUNK_SIZE) {
    const chunk = voters.slice(i, i + CHUNK_SIZE);
    const docs = chunk.map(v => {
      const familyId = voterFamilyMap.get(`${v.wardNo}_1_${v.serialNo}`) || `FAM_W${v.wardNo}_P1_S${v.serialNo}`;
      const caste = predictCaste({
        nameHi: v.nameHi,
        relativeNameHi: v.relativeNameHi,
        villageNameHi: 'मौलासर'
      }) || '';

      return {
        ...v,
        familyId,
        caste,
        createdAt: new Date(),
        voted: false,
        votedAt: null,
        assignedWorker: '',
        supportStatus: 'unmarked',
        isMigrant: false,
        photoUrl: ''
      };
    });

    await votersColl.insertMany(docs, { ordered: false });
    console.log(`Inserted chunk ${Math.floor(i / CHUNK_SIZE) + 1} (${docs.length} voters)...`);
  }

  const finalCount = await votersColl.countDocuments({ organizationId: orgId });
  console.log(`=== KHETA RAM IMPORT SUCCESS ===`);
  console.log(`Total voters in Kheta Ram org (${orgId}): ${finalCount}`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
