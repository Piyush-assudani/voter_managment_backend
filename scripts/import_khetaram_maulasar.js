const fs = require('fs');
const mongoose = require('mongoose');
const crypto = require('crypto');
require('dotenv').config({ path: '/Users/piyush/Documents/Moxrathore_projects/vijaysetu/backend/.env' });
const { Organization, Voter } = require('/Users/piyush/Documents/Moxrathore_projects/vijaysetu/backend/models');

const ORG_ID = 'tenant_21f256b7-ebe9-4767-ac6b-a0780dfb5fea'; // Kheta Ram

async function run() {
  console.log('Connecting to MongoDB Atlas...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected!');

  const raw = fs.readFileSync('/tmp/maulasar_clean_voters.json', 'utf8');
  const votersData = JSON.parse(raw);
  console.log(`Loaded ${votersData.length} clean voters from JSON.`);

  // Clean relation type helper
  function cleanRelationType(rt) {
    if (!rt) return 'पिता';
    if (rt.includes('पति')) return 'पति';
    if (rt.includes('माता')) return 'माता';
    return 'पिता';
  }

  // Clear existing voters for Kheta Ram
  await Voter.deleteMany({ organizationId: ORG_ID });
  console.log('Cleaned old records for Kheta Ram.');

  const wardsSet = new Set();
  const docs = votersData.map((v, idx) => {
    const wardNum = v.ward || v.ward_no || 1;
    const wardStr = String(wardNum).trim();
    wardsSet.add(wardStr);

    const vName = String(v.name || v.name_hi || 'मतदाता').trim();
    const rName = String(v.relation_name || v.relative_name_hi || '').trim();
    const relType = cleanRelationType(v.relation_type);
    const houseStr = String(v.house_no || '-').trim();

    return {
      _id: `voter_${crypto.randomUUID()}`,
      epic: String(v.epic || '').trim().toUpperCase(),
      wardNo: wardStr,
      panchayat: 'मौलासर',
      panchayatHi: 'मौलासर',
      partNo: wardStr,
      serialNo: Number(v.serial || v.serial_no) || idx + 1,
      nameEn: vName,
      nameHi: vName,
      age: Number(v.age) || 0,
      gender: v.gender || (relType === 'पति' ? 'स्त्री' : 'पुरुष'),
      relationType: relType,
      relativeNameEn: rName,
      relativeNameHi: rName,
      houseNo: houseStr,
      houseNoHi: houseStr,
      mobileNo: '',
      caste: '',
      supportStatus: 'unmarked',
      status: 'Active',
      voted: false,
      votedAt: null,
      surety: '',
      notes: '',
      isMigrant: false,
      migrantLocation: '',
      assignedWorker: null,
      villageName: 'मौलासर',
      villageNameHi: 'मौलासर',
      boothName: `बूथ वार्ड ${wardStr}`,
      organizationId: ORG_ID,
      familyId: '',
      photoUrl: '',
      createdAt: new Date()
    };
  });

  console.log(`Inserting ${docs.length} verified voters in chunks of 1000...`);
  const chunkSize = 1000;
  for (let i = 0; i < docs.length; i += chunkSize) {
    const chunk = docs.slice(i, i + chunkSize);
    await Voter.insertMany(chunk, { ordered: false });
    console.log(`  Inserted ${Math.min(i + chunkSize, docs.length)} / ${docs.length}`);
  }

  // Update Organization
  const sortedWards = Array.from(wardsSet).sort((a, b) => Number(a) - Number(b));
  console.log('Configuring wards in Organization:', sortedWards);

  await Organization.findByIdAndUpdate(ORG_ID, {
    $set: {
      wards: sortedWards,
      allowedWards: sortedWards,
      panchayats: ['मौलासर'],
      allowedPanchayats: ['मौलासर'],
      ulbWardGramPanchayat: 'मौलासर',
      ulbPanchayatSamiti: 'मौलासर',
      district: 'डीडवाना-कुचामन',
      'slipConfig.candidateName': 'खेता राम',
      'slipConfig.candidateNameEn': 'Kheta Ram',
      'slipConfig.appealHeadline': '(1 नंबर पर बटन दबाएं)'
    }
  });

  const finalCount = await Voter.countDocuments({ organizationId: ORG_ID });
  console.log(`\n🎉 Verification: Kheta Ram now has ${finalCount} voters in MongoDB!`);

  // Ward-wise breakdown
  const wardBreakdown = await Voter.aggregate([
    { $match: { organizationId: ORG_ID } },
    { $group: { _id: '$wardNo', count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);
  console.log('\nWard breakdown in DB:');
  console.table(wardBreakdown);

  process.exit(0);
}

run().catch(err => {
  console.error('Fatal error during import:', err);
  process.exit(1);
});
