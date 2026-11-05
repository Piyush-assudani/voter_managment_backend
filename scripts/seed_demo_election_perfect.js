const fs = require('fs');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { Voter, Organization } = require('../models');

const DEMO_ORG_ID = 'org_demo_election_2025';

const REPLACEMENTS = [
  ['जकठ मल जहापगीर', 'जेठमल जांगिड़'],
  ['जकठ मल जांगिड़', 'जेठमल जांगिड़'],
  ['जकठ मल', 'जेठमल'],
  ['जकठमल', 'जेठमल'],
  ['जकठमी जांगिड़', 'जेठमल जांगिड़'],
  ['जकठमी', 'जेठमल जांगिड़'],
  ['जकठाराम', 'जेठाराम'],
  ['जकठा राम', 'जेठाराम'],
  ['जकठीदेवी', 'जेठीदेवी'],
  ['जकठब सिंह', 'जेठू सिंह'],
  ['जकठब', 'जेठू'],
  ['कमनीकशोर जांगिड़', 'कमलकिशोर जांगिड़'],
  ['कमनीकशोर', 'कमलकिशोर'],
  ['कमीदकशोर', 'कमलकिशोर'],
  ['कमनलकशयर', 'कमलकिशोर'],
  ['बालदकशोर', 'बालकिशोर'],
  ['नरमल कचमरर', 'निर्मल कुमार जांगिड़'],
  ['नरमल', 'निर्मल'],
  ['नामी कुमार जांगिड़', 'निर्मल कुमार जांगिड़'],
  ['नामी कुमार', 'निर्मल कुमार जांगिड़'],
  ['अपजु जांगिड़', 'अंजू जांगिड़'],
  ['अपजब जापगीड', 'अंजू जांगिड़'],
  ['अपजु कुमारी', 'अंजू कुमारी'],
  ['अपजु देवी', 'अंजू देवी'],
  ['अपजु नतारडी', 'अंजू नतारडी'],
  ['अपजु शर्मा', 'अंजू शर्मा'],
  ['अपजु', 'अंजू'],
  ['अपजब कंवर', 'अंजूकंवर'],
  ['अपजब देवी', 'अंजू देवी'],
  ['अपजब शर्मा', 'अंजू शर्मा'],
  ['अपजब', 'अंजू'],
  ['अपजच', 'अंजू'],
  ['अपजनर', 'अंजना'],
  ['अपजनल', 'अंजली'],
  ['अपजील', 'अंजली'],
  ['अपकुर पुरोनहत', 'अंकुर पुरोहित'],
  ['अपकुर', 'अंकुर'],
  ['पुरोनहत', 'पुरोहित'],
  ['मपजबकपार', 'मंजूकंवर'],
  ['मपजब देवी', 'मंजू देवी'],
  ['मपजब', 'मंजू'],
  ['नपददकशोर जहापगीर', 'नंदकिशोर जांगिड़'],
  ['नपददकशोर शर्मा', 'नंदकिशोर शर्मा'],
  ['नपददकशोर', 'नंदकिशोर'],
  ['ननददकशोर', 'नंदकिशोर'],
  ['राजनपददनी', 'राजनंदिनी'],
  ['ननदकता जांगिड़', 'नंदिता जांगिड़'],
  ['ननदकता जहापगीर जहापगीर', 'नंदिता जांगिड़'],
  ['ननदकता प्रजापत', 'नंदिता प्रजापत'],
  ['ननदकता गौड़', 'नंदिता गौड़'],
  ['ननदकता नाई', 'नंदिता नाई'],
  ['ननदकता बलारा', 'नंदिता बलारा'],
  ['ननदकता', 'नंदिता'],
  ['नननतन जापगीड', 'नितिन जांगिड़'],
  ['शीदकशन', 'श्रीकिशन'],
  ['शी गोपाल जांगिड़', 'श्री गोपाल जांगिड़'],
  ['शी गोपाल', 'श्री गोपाल'],
  ['पतरसलदेवी', 'पतासी देवी'],
  ['पतरसलदरक', 'पतासी देवी'],
  ['पतरसल', 'पतासी'],
  ['रयनहत', 'रोहित'],
  ['रोनहत', 'रोहित'],
  ['रोनहताश कुमार', 'रोहिताश कुमार'],
  ['रोनहताश', 'रोहिताश'],
  ['धमारराम', 'धर्माराम'],
  ['धमानद', 'धर्मानंद'],
  ['अमाचपद जहापगीर', 'अमरचंद जांगिड़'],
  ['अमाचपद', 'अमरचंद'],
  ['अमा सिंह', 'अमर सिंह'],
  ['कनहजब र लाल जांगिड़', 'कन्हैयालाल जांगिड़'],
  ['कनहजब र लाल', 'कन्हैयालाल'],
  ['ओकारमी जापगीड', 'ओंकारमल जांगिड़'],
  ['ओकारमी', 'ओंकारमल'],
  ['गोपाल जापगीड', 'गोपाल जांगिड़'],
  ['अनिल जापगीड', 'अनिल जांगिड़'],
  ['जापगीड', 'जांगिड़'],
  ['जहापगीर', 'जांगिड़'],
  ['जहरपगलर', 'जांगिड़'],
  ['श्याम सुपदा', 'श्याम सुंदर'],
  ['ताण शर्मा', 'ताराचंद शर्मा'],
  ['बाल मुकुनद', 'बालमुकुंद'],
  ['सुखदेवदेवी जांगिड़', 'सुखदेव जांगिड़'],
  ['पभुराम', 'प्रभुराम']
];

function cleanSpecific(s) {
  if (!s) return s;
  let res = s;
  for (const [from, to] of REPLACEMENTS) {
    if (res.includes(from)) {
      res = res.split(from).join(to);
    }
  }
  return res.trim();
}

function detectCaste(name, relName) {
  const combined = `${name} ${relName}`;
  if (/जांगिड़|सुथार|खाती/i.test(combined)) return 'जांगिड़';
  if (/सिंह|राठौड़|कंवर|शेखावत|भाटी|चौहान/i.test(combined)) return 'राजपूत';
  if (/चौधरी|जाट|बलारा|सहारण|ढाका|मुण्डेल|राणवा|कड़वा/i.test(combined)) return 'जाट (चौधरी)';
  if (/शर्मा|दाधीच|पुरोहित|पारीक|गौड़|जोशी|व्यास/i.test(combined)) return 'ब्राह्मण / शर्मा';
  if (/सैनी|माली/i.test(combined)) return 'सैनी / माली';
  if (/सोनी|स्वर्णकार/i.test(combined)) return 'सोनी';
  if (/मेघवाल|बैरवा/i.test(combined)) return 'मेघवाल (SC)';
  if (/रैबारी|देवासी/i.test(combined)) return 'रैबारी (देवासी)';
  if (/खान|मोहम्मद|बानो|बेगम|अंसारी|सईदा|कलाम/i.test(combined)) return 'मुस्लिम';
  if (/प्रजापत|कुम्हार/i.test(combined)) return 'प्रजापत';
  if (/नाई|सैन/i.test(combined)) return 'नाई (सैन)';
  if (/दर्जी|छीपा/i.test(combined)) return 'दर्जी / छीपा';
  return 'अन्य सामान्य';
}

const HINDI_TO_ENG = {
  'छोगाराम': 'Chhogaram',
  'इन्द्रा': 'Indra',
  'मंजू देवी': 'Manju Devi',
  'रामदेव रैबारी': 'Ramdev Rebari',
  'हेमा राम': 'Hema Ram',
  'गुलाबदेवी': 'Gulab Devi',
  'जुगल किशोर': 'Jugal Kishor',
  'गौरी देवी': 'Gauri Devi',
  'चन्द्रकान्ता सैनी': 'Chandrakanta Saini',
  'प्रदीप कुमार सैनी': 'Pradeep Kumar Saini',
  'रूपेश सैनी': 'Rupesh Saini',
  'रतनलाल': 'Ratan Lal',
  'मदनीदेवी': 'Madani Devi',
  'प्रमोद कुमार': 'Pramod Kumar',
  'किरण जांगिड़': 'Kiran Jangir',
  'सुनील कुमार': 'Sunil Kumar',
  'मोनू जांगिड़': 'Monu Jangir',
  'गुंजन चौधरी': 'Gunjan Choudhary',
  'ओम प्रकाश': 'Om Prakash',
  'निर्मला चौधरी': 'Nirmala Choudhary',
  'सम्पत': 'Sampat',
  'चुनाराम राणवा': 'Chunaram Ranwa',
  'महेन्द्र सिंह': 'Mahendra Singh',
  'राजू सिंह': 'Raju Singh',
  'शालिनी कुमारी': 'Shalini Kumari',
  'बदामी देवी': 'Badami Devi',
  'भंवरीदेवी': 'Bhanwari Devi',
  'प्रहलादराम': 'Prahlad Ram',
  'संतोष': 'Santosh',
  'अनिता': 'Anita',
  'जेठमल जांगिड़': 'Jethmal Jangir',
  'सुखदेव जांगिड़': 'Sukhdev Jangir',
  'पतासी': 'Patasi',
  'कमलकिशोर जांगिड़': 'Kamal Kishor Jangir',
  'कमल किशोर जांगिड़': 'Kamal Kishor Jangir',
  'निर्मल कुमार जांगिड़': 'Nirmal Kumar Jangir',
  'अंजू जांगिड़': 'Anju Jangir',
  'रोहित कुमार जांगिड़': 'Rohit Kumar Jangir',
  'मंजू जांगिड़': 'Manju Jangir',
  'बजरंग लाल जांगिड़': 'Bajrang Lal Jangir',
  'मुकेश कुमार जांगिड़': 'Mukesh Kumar Jangir',
  'ललित जांगिड़': 'Lalit Jangir',
  'बाबू लाल जांगिड़': 'Babu Lal Jangir',
  'मनीष जांगिड़': 'Manish Jangir',
  'चंचल जांगिड़': 'Chanchal Jangir',
  'महिपाल जांगिड़': 'Mahipal Jangir'
};

function transliterateHindi(text) {
  if (!text) return '';
  if (HINDI_TO_ENG[text]) return HINDI_TO_ENG[text];
  return text;
}

const SUPPORT_STATUSES = ['core', 'core', 'swing', 'swing', 'opposition', 'unmarked'];

async function seedDemo() {
  console.log('Connecting to MongoDB Atlas...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected!');

  const raw = fs.readFileSync('/tmp/maulasar_clean_voters.json', 'utf8');
  const allVoters = JSON.parse(raw);
  
  // Filter Wards 1 to 5 (1,921 clean voters)
  const demoVoters = allVoters.filter(v => v.ward >= 1 && v.ward <= 5);
  console.log(`Processing ${demoVoters.length} clean voters for Demo (Wards 1-5)...`);

  // Clear existing voters in Demo Org
  const deleted = await Voter.deleteMany({ organizationId: DEMO_ORG_ID });
  console.log(`Removed ${deleted.deletedCount} old/corrupted records from Demo Org.`);

  const docs = demoVoters.map((v, idx) => {
    const wardNum = v.ward || 1;
    const wardStr = String(wardNum).trim();

    let vName = cleanSpecific(String(v.name || 'मतदाता').trim());
    let rName = cleanSpecific(String(v.relation_name || '').trim());
    let relType = v.relation_type || 'पिता';
    if (relType.includes('पति')) relType = 'पति';
    else if (relType.includes('माता')) relType = 'माता';
    else relType = 'पिता';

    const houseStr = String(v.house_no || idx + 1).trim();

    // Specific cleanups for House 35 Ward 1
    if (wardStr === '1') {
      if (v.serial === 111) { vName = 'जेठमल जांगिड़'; rName = 'सुखदेव जांगिड़'; }
      if (v.serial === 112) { vName = 'पतासी'; rName = 'जेठमल जांगिड़'; }
      if (v.serial === 113) { vName = 'कमलकिशोर जांगिड़'; rName = 'जेठमल जांगिड़'; }
      if (v.serial === 114) { vName = 'निर्मल कुमार जांगिड़'; rName = 'जेठमल जांगिड़'; }
      if (v.serial === 115) { vName = 'अंजू जांगिड़'; rName = 'निर्मल कुमार जांगिड़'; }
      if (v.serial === 116) { vName = 'रोहित कुमार जांगिड़'; rName = 'जेठमल जांगिड़'; }
      if (v.serial === 117) { vName = 'मंजू जांगिड़'; rName = 'कमलकिशोर जांगिड़'; }
    }

    if (rName === 'सुखदेवदेवी') {
      rName = vName.includes('जांगिड़') ? 'सुखदेव जांगिड़' : 'सुखदेव';
    }

    const caste = detectCaste(vName, rName);
    const supportStatus = SUPPORT_STATUSES[idx % SUPPORT_STATUSES.length];

    const cleanHouse = houseStr.replace(/[^0-9a-zA-Z]/g, '');
    const familyId = `fam_w${wardStr}_h${cleanHouse || '1'}`;

    return {
      _id: `voter_demo_${wardStr}_${v.serial}`,
      epic: String(v.epic || '').trim().toUpperCase(),
      wardNo: wardStr,
      panchayat: 'आदर्श नगर',
      panchayatHi: 'आदर्श नगर',
      partNo: wardStr,
      serialNo: Number(v.serial) || idx + 1,
      nameEn: transliterateHindi(vName),
      nameHi: vName,
      age: Number(v.age) || 35,
      gender: v.gender || (relType === 'पति' ? 'स्त्री' : 'पुरुष'),
      relationType: relType,
      relativeNameEn: transliterateHindi(rName),
      relativeNameHi: rName,
      houseNo: houseStr,
      houseNoHi: houseStr,
      mobileNo: '',
      caste: caste,
      supportStatus: supportStatus,
      status: 'Active',
      voted: idx % 3 === 0,
      votedAt: idx % 3 === 0 ? new Date() : null,
      surety: idx % 4 === 0 ? 'उच्च' : '',
      notes: '',
      isMigrant: idx % 15 === 0,
      migrantLocation: idx % 15 === 0 ? 'जयपुर / सूरत' : '',
      assignedWorker: null,
      villageName: 'आदर्श नगर',
      villageNameHi: 'आदर्श नगर',
      boothName: `राजकीय उच्च प्राथमिक विद्यालय, कक्ष क्र. ${wardStr}`,
      organizationId: DEMO_ORG_ID,
      familyId: familyId,
      photoUrl: '',
      createdAt: new Date()
    };
  });

  console.log(`Inserting ${docs.length} pristine voters into Demo Org in chunks...`);
  const chunkSize = 500;
  for (let i = 0; i < docs.length; i += chunkSize) {
    const chunk = docs.slice(i, i + chunkSize);
    await Voter.insertMany(chunk, { ordered: false });
    console.log(`  Inserted ${Math.min(i + chunkSize, docs.length)} / ${docs.length}`);
  }

  // Configure Demo Organization
  await Organization.findByIdAndUpdate(DEMO_ORG_ID, {
    $set: {
      name: 'विजयसेतु - आदर्श चुनाव अभियान (Demo)',
      wards: ['1', '2', '3', '4', '5'],
      allowedWards: ['1', '2', '3', '4', '5'],
      panchayats: ['आदर्श नगर'],
      allowedPanchayats: ['आदर्श नगर'],
      district: 'जोधपुर',
      ulbWardGramPanchayat: 'आदर्श नगर',
      ulbPanchayatSamiti: 'जोधपुर',
      isActive: true,
      isDemo: true,
      'slipConfig.candidateName': 'देवेन्द्र सिंह राठौड़',
      'slipConfig.candidateNameEn': 'Devendra Singh Rathore',
      'slipConfig.partySymbolName': 'कमल (Lotus)',
      'slipConfig.subTitle': 'मतदाता सूचना पर्ची (Voter Slip) · वार्ड 1 से 5 (आदर्श नगर)',
      'slipConfig.appealHeadline': '(1 नंबर पर कमल का बटन दबाएं)',
      'slipConfig.appealText': 'वार्ड के सर्वांगीण विकास हेतु देवेन्द्र सिंह राठौड़ को अपना अमूल्य वोट देकर भारी मतों से विजयी बनाएं।',
      'slipConfig.footerAppeal': 'कमल का बटन दबाएं और भारी मतों से विजयी बनाएं',
      'slipConfig.pollingStationFallback': 'राजकीय उच्च प्राथमिक विद्यालय, मुख्य बाज़ार, आदर्श नगर',
      'slipConfig.pollingDate': '15 नवम्बर 2026 (प्रातः 7:00 से सायं 5:00 बजे तक)'
    }
  });

  console.log('✅ Demo Organization configured with Wards 1-5 and clean candidate details.');

  const totalInDemo = await Voter.countDocuments({ organizationId: DEMO_ORG_ID });
  console.log(`\n🎉 Total clean voters now in Demo: ${totalInDemo}`);

  await mongoose.disconnect();
}

seedDemo().catch(console.error);

