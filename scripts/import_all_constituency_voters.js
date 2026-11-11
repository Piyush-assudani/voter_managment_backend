/**
 * Import all 6,727 voters for खेराज राम हुड्डा (Panchayat Samiti Ward 22)
 * Spans 4 Gram Panchayats: सांभरा, अकारली बक्शीराम, बागुंडी, खेड़
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const path = require('path');
const crypto = require('crypto');
const { Voter, Organization } = require('../models/index');

const EXCEL_PATH = path.resolve(__dirname, '../../Master_Voters_Panchayat_Samiti_22.xlsx');
const TENANT_ID = 'tenant_f49981aa-8d3b-4e1c-9771-557dc5aca1de';

async function importAll() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB.');

  const org = await Organization.findById(TENANT_ID);
  if (!org) {
    console.error('Org not found!');
    process.exit(1);
  }

  console.log(`Loading Excel from ${EXCEL_PATH}...`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(EXCEL_PATH);
  const masterSheet = workbook.getWorksheet('All Voters (Master)');
  console.log(`Read ${masterSheet.rowCount} rows from Master Sheet.`);

  // Build Voter Documents
  const voterDocs = [];
  const panchayatSet = new Set();
  const wardSet = new Set();

  masterSheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header

    const getVal = (col) => {
      const v = row.getCell(col).value;
      if (v === null || v === undefined) return '';
      if (typeof v === 'object' && v.text) return v.text;
      return String(v).trim();
    };

    const pName = getVal(3);
    const wNo = getVal(4) || '1';
    panchayatSet.add(pName);
    wardSet.add(wNo);

    const house = getVal(12) || '-';
    const serial = parseInt(getVal(1), 10) || voterDocs.length + 1;
    const familyId = `FAM_${pName.substring(0,3)}_${wNo}_H${house !== '-' ? house : 'S' + serial}`;

    voterDocs.push({
      _id: 'voter_' + crypto.randomUUID(),
      serialNo: serial,
      epic: getVal(2),
      nameHi: getVal(7),
      nameEn: getVal(8),
      relativeNameHi: getVal(10),
      relativeNameEn: getVal(11),
      relationType: getVal(9) || 'पिता',
      houseNo: house,
      houseNoHi: house,
      age: parseInt(getVal(13), 10) || 30,
      gender: getVal(14) || 'पुरुष',
      wardNo: wNo,
      partNo: getVal(5) || '1',
      status: getVal(18) === 'विलोपित' ? 'Deleted' : 'Active',
      organizationId: TENANT_ID,
      panchayat: pName,
      panchayatHi: pName,
      villageName: getVal(17),
      villageNameHi: getVal(17),
      mobile: getVal(16),
      mobileNo: getVal(16),
      caste: getVal(15),
      familyId: familyId,
      familyHead: '',
      createdAt: new Date(),
      voted: false,
      votedAt: null,
      assignedWorker: '',
      supportStatus: 'unmarked',
      isMigrant: false,
      photoUrl: ''
    });
  });

  console.log(`Deleting existing voters for ${org.name}...`);
  await Voter.deleteMany({ organizationId: TENANT_ID });

  console.log(`Inserting ${voterDocs.length} voters in chunks...`);
  const chunkSize = 1000;
  for (let i = 0; i < voterDocs.length; i += chunkSize) {
    const chunk = voterDocs.slice(i, i + chunkSize);
    await Voter.insertMany(chunk);
    console.log(`Inserted chunk ${Math.floor(i / chunkSize) + 1} (${chunk.length} voters)...`);
  }

  // Update Org Panchayats and Wards
  const pList = Array.from(panchayatSet);
  const wList = Array.from(wardSet).sort((a,b) => parseInt(a,10) - parseInt(b,10));
  await Organization.findByIdAndUpdate(TENANT_ID, {
    $set: {
      panchayats: pList,
      allowedPanchayats: pList,
      wards: wList,
      allowedWards: wList
    }
  });

  console.log(`Updated organization with Panchayats: ${JSON.stringify(pList)} and Wards: ${JSON.stringify(wList)}`);
  console.log(`\n=== IMPORT COMPLETE: Total ${voterDocs.length} voters uploaded! ===`);
  process.exit(0);
}

importAll().catch(e => {
  console.error('Import error:', e);
  process.exit(1);
});
