const path = require('path');
const fs = require('fs');
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

  const kherajOrg = await orgsColl.findOne({ name: /खेराज राम हुड्डा/i });
  if (!kherajOrg) {
    console.error('खेराज राम हुड्डा organization not found!');
    process.exit(1);
  }

  const orgId = String(kherajOrg._id);
  console.log(`Found खेराज राम हुड्डा org with ID: ${orgId}`);

  const filePath = path.join(__dirname, '../../doc00229020261019003738_voters.xlsx');
  if (!fs.existsSync(filePath)) {
    console.error(`Excel file not found at ${filePath}`);
    process.exit(1);
  }

  console.log(`Loading Excel from ${filePath}...`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0]; // Master sheet

  const voters = [];
  const wardSet = new Set();
  const panchayatSet = new Set();

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Skip header

    const epic = String(row.getCell(1).value || '').trim();
    const wardVal = String(row.getCell(2).value || '1').trim();
    const partVal = String(row.getCell(3).value || '108').trim();
    const serialNo = parseInt(row.getCell(4).value, 10);
    const nameEn = String(row.getCell(5).value || '').trim();
    const nameHi = String(row.getCell(6).value || '').trim();
    const rawAge = row.getCell(7).value;
    const age = rawAge ? parseInt(rawAge, 10) : 30;
    let gender = String(row.getCell(8).value || 'पुरुष').trim();
    const relationType = String(row.getCell(9).value || 'पिता').trim();
    const relativeNameEn = String(row.getCell(10).value || '').trim();
    const relativeNameHi = String(row.getCell(11).value || '').trim();
    let houseNo = String(row.getCell(12).value || '-').trim();
    if (houseNo === '0' || houseNo === '00') houseNo = '-';
    const mobile = String(row.getCell(14).value || '').trim();
    const casteVal = String(row.getCell(15).value || '').trim();
    const familyIdVal = String(row.getCell(16).value || '').trim();
    const villageEn = String(row.getCell(17).value || 'Sambhara').trim();
    const villageHi = String(row.getCell(18).value || 'सांभरा सम्पूर्ण ग्राम का भाग').trim();

    if (gender !== 'पुरुष' && gender !== 'स्त्री') {
      gender = (relationType === 'पति') ? 'स्त्री' : 'पुरुष';
    }

    if (serialNo && nameHi && nameHi !== 'मतदाता') {
      wardSet.add(wardVal);
      panchayatSet.add('सांभरा');
      voters.push({
        serialNo,
        epic: epic || `RJ/W${wardVal}/${serialNo}`,
        nameHi,
        nameEn: nameEn || nameHi,
        relativeNameHi: relativeNameHi !== '-' ? relativeNameHi : '',
        relativeNameEn: relativeNameEn !== '-' ? relativeNameEn : (relativeNameHi !== '-' ? relativeNameHi : ''),
        relationType,
        houseNo,
        age,
        gender,
        wardNo: wardVal,
        partNo: partVal,
        status: 'Active',
        organizationId: orgId,
        panchayat: 'सांभरा',
        panchayatHi: 'सांभरा',
        villageName: villageEn,
        villageNameHi: villageHi,
        mobile,
        caste: casteVal,
        familyId: familyIdVal
      });
    }
  });

  console.log(`Parsed ${voters.length} valid authentic voters across Wards: ${Array.from(wardSet).sort((a,b)=>a-b).join(', ')}`);

  // Group into families
  const { families, voterFamilyMap } = groupVotersIntoFamilies(voters);
  console.log(`Grouped into ${families.length} families.`);

  // Clear existing voters for Kheraj Ram Org before fresh clean import
  const delRes = await votersColl.deleteMany({ organizationId: orgId });
  console.log(`Deleted ${delRes.deletedCount} old records for ${kherajOrg.name}.`);

  // Bulk insert in chunks of 1000
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < voters.length; i += CHUNK_SIZE) {
    const chunk = voters.slice(i, i + CHUNK_SIZE);
    const docs = chunk.map(v => {
      const familyId = v.familyId || voterFamilyMap.get(`${v.wardNo}_${v.partNo}_${v.serialNo}`) || `FAM_W${v.wardNo}_S${v.serialNo}`;
      const caste = v.caste || predictCaste({
        nameHi: v.nameHi,
        relativeNameHi: v.relativeNameHi,
        villageNameHi: v.villageNameHi
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

  // Update Organization's allowedWards, wards, and panchayats
  const sortedWards = Array.from(wardSet).sort((a,b) => parseInt(a) - parseInt(b));
  await orgsColl.updateOne(
    { _id: kherajOrg._id },
    {
      $set: {
        allowedWards: sortedWards,
        wards: sortedWards,
        allowedPanchayats: ['सांभरा'],
        panchayats: ['सांभरा'],
        district: 'बालोतरा',
        ulbPanchayatSamiti: 'बालोतरा',
        ulbWardGramPanchayat: 'सांभरा'
      }
    }
  );
  console.log(`Updated organization wards to: [${sortedWards.join(', ')}]`);

  const finalCount = await votersColl.countDocuments({ organizationId: orgId });
  console.log(`\n=== IMPORT COMPLETE ===`);
  console.log(`Successfully imported ${finalCount} voters for ${kherajOrg.name} (${orgId})!`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal error during import:', err);
  process.exit(1);
});

