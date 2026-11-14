const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const ORG_ID = 'tenant_f49981aa-8d3b-4e1c-9771-557dc5aca1de';

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is missing from environment');
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const votersColl = db.collection('voters');
  const orgColl = db.collection('organizations');

  const org = await orgColl.findOne({ _id: ORG_ID });
  if (!org) {
    throw new Error(`Organization ${ORG_ID} not found!`);
  }
  console.log(`Target Organization: ${org.name} (${ORG_ID})`);

  // Count total voters for this org
  const totalCount = await votersColl.countDocuments({ organizationId: ORG_ID });
  console.log(`Total voters in DB for this organization: ${totalCount}`);

  // Fetch all panchayats and wards
  const groups = await votersColl.aggregate([
    { $match: { organizationId: ORG_ID } },
    { $group: { _id: { panchayat: '$panchayat', wardNo: '$wardNo' }, count: { $sum: 1 } } },
    { $sort: { '_id.panchayat': 1, '_id.wardNo': 1 } }
  ]).toArray();

  console.log(`Found ${groups.length} Panchayat-Ward groups.`);

  let totalUpdated = 0;

  for (const group of groups) {
    const { panchayat, wardNo } = group._id;
    const count = group.count;

    console.log(`\nProcessing ${panchayat} - Ward ${wardNo} (Total: ${count} voters)...`);

    // Fetch all voters for this group
    const list = await votersColl.find({
      organizationId: ORG_ID,
      panchayat,
      wardNo
    }).toArray();

    // Sort voters accurately:
    // Handle the Sambhra Ward 1 outlier where serials 89 and 94 were placed without 4783 offset
    list.sort((a, b) => {
      let aVal = a.serialNo;
      let bVal = b.serialNo;

      if (panchayat === 'सांभरा' && wardNo === '1') {
        if (aVal === 89) aVal = 4872;
        if (aVal === 94) aVal = 4877;
        if (bVal === 89) bVal = 4872;
        if (bVal === 94) bVal = 4877;
      }

      if (aVal !== bVal) return aVal - bVal;
      return String(a._id).localeCompare(String(b._id));
    });

    const bulkOps = [];
    list.forEach((voter, index) => {
      const correctSerial = index + 1;
      if (voter.serialNo !== correctSerial) {
        bulkOps.push({
          updateOne: {
            filter: { _id: voter._id },
            update: { $set: { serialNo: correctSerial } }
          }
        });
      }
    });

    if (bulkOps.length > 0) {
      console.log(`  Updating ${bulkOps.length} voters whose serialNo changed...`);
      const res = await votersColl.bulkWrite(bulkOps, { ordered: false });
      totalUpdated += res.modifiedCount;
      console.log(`  Updated ${res.modifiedCount} records.`);
    } else {
      console.log(`  All serial numbers already match 1..${count}.`);
    }
  }

  console.log(`\n========================================`);
  console.log(`Migration Complete! Total records updated: ${totalUpdated}`);
  console.log(`========================================\n`);

  // Verification step
  console.log('Verifying all groups in DB...');
  const verifyStats = await votersColl.aggregate([
    { $match: { organizationId: ORG_ID } },
    {
      $group: {
        _id: { panchayat: '$panchayat', wardNo: '$wardNo' },
        count: { $sum: 1 },
        minSerial: { $min: '$serialNo' },
        maxSerial: { $max: '$serialNo' }
      }
    },
    { $sort: { '_id.panchayat': 1, '_id.wardNo': 1 } }
  ]).toArray();

  let hasError = false;
  for (const st of verifyStats) {
    const isMin1 = st.minSerial === 1;
    const isMaxCount = st.maxSerial === st.count;
    const status = isMin1 && isMaxCount ? '✅ OK' : '❌ ERROR';
    if (!isMin1 || !isMaxCount) hasError = true;
    console.log(`  ${st._id.panchayat} - Ward ${st._id.wardNo}: ${st.count} voters [${st.minSerial} to ${st.maxSerial}] -> ${status}`);
  }

  if (hasError) {
    console.error('\n❌ Verification found inconsistencies!');
    process.exit(1);
  } else {
    console.log('\n🎉 ALL Wards now strictly start at Serial 1 and end at Serial N!');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

