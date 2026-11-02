const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');
const { Voter, Organization } = require('../models/index');
const { cleanHouseNo, groupVotersIntoFamilies } = require('../lib/familyService');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const TARGET_ORG_ID = 'tenant_40d57d14-4096-47e0-8b2b-d8f6e8699152';
const EXCEL_DIR = path.join(__dirname, '../../Ramdeora_Excel_Output');

function stripNameFromRelative(voterName, relName) {
  if (!voterName || !relName) return relName || '';
  let vn = String(voterName).trim();
  let rn = String(relName).trim();
  if (!rn || !vn) return rn;

  if (rn.startsWith(vn) && rn.length > vn.length) {
    const remainder = rn.slice(vn.length).trim();
    if (remainder.length >= 2) return remainder;
  }
  return rn;
}

const SURNAMES_FOR_HOUSE_MATCH = new Set([
  'जाट', 'मेघवाल', 'कुम्हार', 'शर्मा', 'वर्मा', 'सुथार', 'गोदारा', 'सारण', 'बेनीवाल',
  'खत्री', 'देवी', 'बाई', 'कुमार', 'राम', 'सिंह', 'राठौड़', 'तंवर', 'भाटी', 'पालीवाल'
]);

function getBaseDevanagariName(name) {
  if (!name) return '';
  let s = String(name).trim().replace(/^(?:श्री|श्रीमती|स्व\.|स्वर्गीय|डॉ\.|मा\.|पं\.)\s*/g, '');
  s = s.replace(/\s+/g, ' ');
  const words = s.split(' ');
  if (words.length > 1 && SURNAMES_FOR_HOUSE_MATCH.has(words[words.length - 1])) {
    words.pop();
  }
  return words.join('').replace(/[ंँ]/g, 'न');
}

function resolveFamilyHouseNumbers(voterList) {
  if (!Array.isArray(voterList) || voterList.length === 0) return voterList;

  // 1. Clean and normalize existing house numbers
  for (const v of voterList) {
    v.houseNo = cleanHouseNo(v.houseNo);
    v.houseNoHi = v.houseNo;
  }

  // 2. Verified pool with authentic house numbers
  const validPool = voterList.filter(v => v.houseNo && v.houseNo !== '-');
  if (validPool.length === 0) return voterList;

  // 3. Resolve for voters with missing or '-' house numbers
  for (const v of voterList) {
    if (v.houseNo && v.houseNo !== '-') continue;

    const relName = (v.relativeNameHi || '').trim();
    const relType = v.relationType || 'पिता';
    const vName = (v.nameHi || '').trim();
    const vGender = v.gender || '';

    const cleanRelBase = getBaseDevanagariName(relName);
    const cleanVBase = getBaseDevanagariName(vName);

    let matchedHouse = null;

    if (relType === 'पति' && relName) {
      const husband = validPool.find(c => {
        if (c.gender === 'स्त्री') return false;
        const cBase = getBaseDevanagariName(c.nameHi);
        return cBase && cBase === cleanRelBase;
      });
      if (husband) matchedHouse = husband.houseNo;
    }

    if (!matchedHouse && relType === 'पिता' && relName) {
      const father = validPool.find(c => {
        const cBase = getBaseDevanagariName(c.nameHi);
        return cBase && cBase === cleanRelBase;
      });
      if (father) {
        matchedHouse = father.houseNo;
      } else {
        const sibling = validPool.find(c => {
          if (c === v) return false;
          const cRelBase = getBaseDevanagariName(c.relativeNameHi);
          return cRelBase && cRelBase === cleanRelBase;
        });
        if (sibling) matchedHouse = sibling.houseNo;
      }
    }

    if (!matchedHouse && vGender === 'पुरुष' && vName) {
      const childOrWife = validPool.find(c => {
        const cRelBase = getBaseDevanagariName(c.relativeNameHi);
        return cRelBase && cRelBase === cleanVBase;
      });
      if (childOrWife) matchedHouse = childOrWife.houseNo;
    }

    if (matchedHouse) {
      v.houseNo = matchedHouse;
      v.houseNoHi = matchedHouse;
    }
  }

  // Final fallback
  for (const v of voterList) {
    if (!v.houseNo) {
      v.houseNo = '-';
      v.houseNoHi = '-';
    }
  }

  return voterList;
}

async function runImport() {
  console.log('====================================================');
  console.log('🚀 RAMDEORA 23 WARDS MASTER VOTER IMPORT STARTING');
  console.log('Target Organization:', TARGET_ORG_ID);
  console.log('Source Excel Folder:', EXCEL_DIR);
  console.log('====================================================\n');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB Atlas successfully.');

  const org = await Organization.findById(TARGET_ORG_ID);
  if (!org) {
    throw new Error(`Target organization ${TARGET_ORG_ID} not found!`);
  }
  console.log(`Found organization: "${org.name}"`);

  // List all 23 files
  const files = fs.readdirSync(EXCEL_DIR)
    .filter(f => f.endsWith('.xlsx'))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/[^\d]/g, '') || '0', 10);
      const numB = parseInt(b.replace(/[^\d]/g, '') || '0', 10);
      return numA - numB;
    });

  console.log(`Found ${files.length} Excel files to process.\n`);

  const allVoters = [];
  const detectedWards = new Set();

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const filename = files[fileIdx];
    const filePath = path.join(EXCEL_DIR, filename);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const worksheet = workbook.getWorksheet('Voters') || workbook.worksheets[0];
    const wardVoters = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip headers

      const getVal = (col) => {
        const c = row.getCell(col);
        return String(c.value !== undefined && c.value !== null ? c.value : '').trim();
      };

      const rawEpic = getVal(1).toUpperCase().replace(/[\s\u200B\uFEFF]/g, '');
      const wardNo = getVal(2) || String(fileIdx + 1);
      const partNo = getVal(3) || '1';
      const rawSerial = getVal(4);
      const serialNo = parseInt(rawSerial, 10) || (rowNumber - 1);
      const nameEn = getVal(5);
      const nameHi = getVal(6);
      const rawAge = parseInt(getVal(7), 10);
      const age = (!isNaN(rawAge) && rawAge >= 18 && rawAge <= 125) ? rawAge : 30;
      let gender = getVal(8);
      if (['m', 'male', 'पुरुष'].includes(gender.toLowerCase())) gender = 'पुरुष';
      else if (['f', 'female', 'स्त्री', 'महिला'].includes(gender.toLowerCase())) gender = 'स्त्री';
      else gender = gender || 'अन्य';

      let relationType = getVal(9) || 'पिता';
      if (!['पिता', 'पति', 'माता', 'अन्य'].includes(relationType)) relationType = 'पिता';

      const relativeNameEn = getVal(10);
      let relativeNameHi = stripNameFromRelative(nameHi, getVal(11));
      if (!relativeNameHi || relativeNameHi === 'None') relativeNameHi = '-';

      const rawHouse = getVal(12) || getVal(13);
      const houseNo = cleanHouseNo(rawHouse);

      const mobileNo = getVal(14);
      const caste = getVal(15);
      const villageHi = getVal(18) || getVal(17) || 'रामदेवरा';

      if (!nameHi || nameHi === 'मतदाता' || nameHi.length < 2) return;

      // Assign authentic or clean synthetic epic
      const cleanEpic = (rawEpic && !rawEpic.startsWith('VOTER_') && !rawEpic.startsWith('UNREADABLE_') && !/^\d{1,5}$/.test(rawEpic))
        ? rawEpic
        : `VOTER_W${wardNo}_P${partNo}_S${serialNo}`;

      detectedWards.add(wardNo);

      wardVoters.push({
        _id: `voter_${crypto.randomUUID()}`,
        epic: cleanEpic,
        wardNo: String(wardNo),
        partNo: String(partNo),
        serialNo,
        nameEn: nameEn || nameHi,
        nameHi,
        age,
        gender,
        relationType,
        relativeNameEn: relativeNameEn || (relativeNameHi !== '-' ? relativeNameHi : ''),
        relativeNameHi,
        houseNo,
        houseNoHi: houseNo,
        mobileNo: mobileNo || '',
        caste: caste || '',
        familyId: '',
        villageName: villageHi,
        villageNameHi: villageHi,
        panchayat: 'रामदेवरा',
        panchayatHi: 'रामदेवरा',
        organizationId: TARGET_ORG_ID,
        status: 'Active',
        supportStatus: 'neutral',
        createdAt: new Date(),
        updatedAt: new Date()
      });
    });

    // 1. Resolve family house numbers within ward
    resolveFamilyHouseNumbers(wardVoters);

    // 2. Group into authentic family IDs within ward
    const { families, voterFamilyMap } = groupVotersIntoFamilies(wardVoters);
    for (const v of wardVoters) {
      const famId = voterFamilyMap.get(v);
      if (famId) {
        v.familyId = famId;
      } else {
        v.familyId = `FAM_${v.wardNo}_${v.partNo}_H${v.houseNo.replace(/[^a-zA-Z0-9]/g, '_')}`;
      }
    }

    console.log(`[${fileIdx + 1}/23] ${filename}: Extracted ${wardVoters.length} voters, grouped into ${families.length} families.`);
    allVoters.push(...wardVoters);
  }

  console.log(`\nTotal verified voters to import across all 23 wards: ${allVoters.length}`);

  // 1. Clear any existing voters for this organization to guarantee a pure, clean, duplicate-free state
  console.log(`Clearing existing records for organization ${TARGET_ORG_ID} ...`);
  const delRes = await Voter.deleteMany({ organizationId: TARGET_ORG_ID });
  console.log(`Removed ${delRes.deletedCount} previous voter records.`);

  // 2. Chunked insertion into MongoDB (chunks of 1,000)
  const CHUNK_SIZE = 1000;
  let totalInserted = 0;

  for (let i = 0; i < allVoters.length; i += CHUNK_SIZE) {
    const chunk = allVoters.slice(i, i + CHUNK_SIZE);
    await Voter.insertMany(chunk, { ordered: false });
    totalInserted += chunk.length;
    console.log(`  Inserted ${totalInserted}/${allVoters.length} voters...`);
  }

  // 3. Update Organization with all wards
  const sortedWards = Array.from(detectedWards).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  await Organization.updateOne(
    { _id: TARGET_ORG_ID },
    {
      $set: {
        wards: sortedWards,
        allowedWards: sortedWards,
        district: 'जैसलमेर',
        ulbPanchayatSamiti: 'रामदेवरा (मुख्यालय-पोकरण)',
        ulbWardGramPanchayat: 'रामदेवरा'
      }
    }
  );

  console.log(`\nUpdated Organization wards: ${sortedWards.join(', ')}`);

  // 4. Verify MongoDB counts
  const finalCount = await Voter.countDocuments({ organizationId: TARGET_ORG_ID });
  const wardBreakdown = await Voter.aggregate([
    { $match: { organizationId: TARGET_ORG_ID } },
    { $group: { _id: '$wardNo', count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);

  console.log('\n====================================================');
  console.log('🎉 IMPORT COMPLETED SUCCESSFULLY!');
  console.log(`Total voters in DB for "समंदर सिंह तंवर": ${finalCount}`);
  console.log('Ward-wise breakdown:');
  for (const wb of wardBreakdown) {
    console.log(`  Ward ${wb._id}: ${wb.count} voters`);
  }
  console.log('====================================================\n');

  await mongoose.disconnect();
}

runImport().catch(err => {
  console.error('FATAL IMPORT ERROR:', err);
  process.exit(1);
});
