const fs = require('fs');
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

  console.log('Connecting to MongoDB Atlas...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.');

  const votersColl = mongoose.connection.db.collection('voters');
  const orgId = 'org_demo_election_2025';

  const files = [
    { file: '/tmp/test_bahadurpur_w6.xlsx', ward: '6' },
    { file: '/tmp/test_bahadurpur_w7.xlsx', ward: '7' }
  ];

  let totalUpdated = 0;

  for (const { file, ward } of files) {
    if (!fs.existsSync(file)) {
      console.error(`File not found: ${file}`);
      continue;
    }

    console.log(`Loading ${file} for Ward ${ward}...`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    const worksheet = workbook.worksheets[0];

    const voters = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Header

      const epic = String(row.getCell(1).value || '').trim();
      const wardVal = String(row.getCell(2).value || ward).trim();
      const partVal = String(row.getCell(3).value || '1').trim();
      const serialNo = parseInt(row.getCell(4).value, 10);
      const nameEn = String(row.getCell(5).value || '').trim();
      const nameHi = String(row.getCell(6).value || '').trim();
      const rawAge = row.getCell(7).value;
      const age = rawAge ? parseInt(rawAge, 10) : null;
      let gender = String(row.getCell(8).value || '').trim();
      const relationType = String(row.getCell(9).value || 'पिता').trim();
      const relativeNameEn = String(row.getCell(10).value || '').trim();
      const relativeNameHi = String(row.getCell(11).value || '').trim();
      let houseNo = String(row.getCell(12).value || '-').trim();
      if (houseNo === '0' || houseNo === '00') houseNo = '-';

      if (gender !== 'पुरुष' && gender !== 'स्त्री') {
        gender = (relationType === 'पति') ? 'स्त्री' : 'पुरुष';
      }

      if (serialNo && nameHi && nameHi !== 'मतदाता') {
        voters.push({
          serialNo,
          epic: epic || `VOTER_W${ward}_P1_${serialNo}`,
          nameHi,
          nameEn: nameEn || nameHi,
          relativeNameHi: relativeNameHi !== '-' ? relativeNameHi : '',
          relativeNameEn: relativeNameEn !== '-' ? relativeNameEn : (relativeNameHi !== '-' ? relativeNameHi : ''),
          relationType,
          houseNo,
          age,
          gender,
          wardNo: String(wardVal),
          partNo: String(partVal),
          status: 'Active',
          organizationId: orgId
        });
      }
    });

    console.log(`Parsed ${voters.length} valid voters for Ward ${ward}.`);

    // Group into families
    const { families, voterFamilyMap } = groupVotersIntoFamilies(voters);
    console.log(`Grouped into ${families.length} families.`);

    const bulkOps = voters.map(v => {
      const familyId = voterFamilyMap.get(`${ward}_1_${v.serialNo}`) || `FAM_W${ward}_P1_S${v.serialNo}`;
      const caste = predictCaste({
        nameHi: v.nameHi,
        relativeNameHi: v.relativeNameHi
      }) || '';

      return {
        updateOne: {
          filter: {
            organizationId: orgId,
            wardNo: String(ward),
            serialNo: v.serialNo
          },
          update: {
            $set: {
              epic: v.epic,
              nameHi: v.nameHi,
              nameEn: v.nameEn,
              relativeNameHi: v.relativeNameHi,
              relativeNameEn: v.relativeNameEn,
              relationType: v.relationType,
              houseNo: v.houseNo,
              age: v.age,
              gender: v.gender,
              caste,
              status: 'Active',
              familyId
            }
          },
          upsert: true
        }
      };
    });

    if (bulkOps.length > 0) {
      const res = await votersColl.bulkWrite(bulkOps, { ordered: false });
      console.log(`Ward ${ward} BulkWrite result: matched=${res.matchedCount}, modified=${res.modifiedCount}, upserted=${res.upsertedCount}`);
      totalUpdated += (res.modifiedCount + res.upsertedCount);
    }
  }

  console.log(`Total records updated/upserted: ${totalUpdated}`);

  // Verification queries
  const totalInOrg = await votersColl.countDocuments({ organizationId: orgId });
  const unreadableCount = await votersColl.countDocuments({ organizationId: orgId, status: 'Unreadable' });
  const matdataCount = await votersColl.countDocuments({ organizationId: orgId, nameHi: 'मतदाता' });
  const activeCount = await votersColl.countDocuments({ organizationId: orgId, status: 'Active' });

  console.log('=== VERIFICATION SUMMARY ===');
  console.log(`Total voters in ${orgId}: ${totalInOrg}`);
  console.log(`Active authentic voters: ${activeCount}`);
  console.log(`Unreadable voters remaining: ${unreadableCount}`);
  console.log(`"मतदाता" names remaining: ${matdataCount}`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
