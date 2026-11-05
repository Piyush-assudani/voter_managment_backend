const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

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

const HINDI_TO_ENG = {
  'जेठमल जांगिड़': 'Jethmal Jangir',
  'सुखदेव जांगिड़': 'Sukhdev Jangir',
  'पतासी': 'Patasi',
  'कमलकिशोर जांगिड़': 'Kamal Kishor Jangir',
  'कमल किशोर जांगिड़': 'Kamal Kishor Jangir',
  'निर्मल कुमार जांगिड़': 'Nirmal Kumar Jangir',
  'अंजू जांगिड़': 'Anju Jangir',
  'रोहित कुमार जांगिड़': 'Rohit Kumar Jangir',
  'मंजू जांगिड़': 'Manju Jangir',
  'कमल किशोर': 'Kamal Kishor',
  'सुखदेव': 'Sukhdev',
  'अंजू नतारडी': 'Anju Natardi',
  'अंजूकंवर': 'Anju Kanwar',
  'अंजू देवी': 'Anju Devi',
  'अंजू कुमारी': 'Anju Kumari',
  'अंजू शर्मा': 'Anju Sharma',
  'अंजू': 'Anju',
  'कमलकिशोर': 'Kamal Kishor',
  'राजनंदिनी': 'Rajnandini',
  'धर्माराम': 'Dharmaram',
  'अंकुर पुरोहित': 'Ankur Purohit',
  'रोहिताश कुमार': 'Rohitash Kumar',
  'जेठू सिंह': 'Jethu Singh',
  'अमर सिंह': 'Amar Singh',
  'मंजूकंवर': 'Manju Kanwar',
  'जेठीदेवी': 'Jethidevi',
  'नंदिता नाई': 'Nandita Nai',
  'श्रीकिशन': 'Shrikishan',
  'जेठाराम': 'Jetharam',
  'नंदिता जांगिड़': 'Nandita Jangir',
  'कन्हैयालाल जांगिड़': 'Kanhaiyalal Jangir',
  'नंदिता प्रजापत': 'Nandita Prajapat',
  'अमरचंद जांगिड़': 'Amarchand Jangir',
  'नंदिता गौड़': 'Nandita Gaur',
  'नंदकिशोर जांगिड़': 'Nandkishor Jangir',
  'श्री गोपाल जांगिड़': 'Shri Gopal Jangir',
  'नंदकिशोर': 'Nandkishor',
  'नंदकिशोर शर्मा': 'Nandkishor Sharma',
  'ताराचंद शर्मा': 'Tarachand Sharma',
  'राजू कुमार जांगिड़': 'Raju Kumar Jangir',
  'नितिन जांगिड़': 'Nitin Jangir',
  'बालमुकुंद बलारा': 'Balmukund Balara',
  'नंदिता बलारा': 'Nandita Balara'
};

function toEnglish(s, fallback) {
  if (HINDI_TO_ENG[s]) return HINDI_TO_ENG[s];
  return fallback || s;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const khetaId = 'tenant_21f256b7-ebe9-4767-ac6b-a0780dfb5fea';
  const CORRUPT_REGEX = /जकठ|कमनीकशोर|कमीदकशोर|कमनलकशयर|नरमल|नामी कुमार|अपजु|अपजब|अपजच|मपजबकपार|जहरपगलर|जहापगीर|जापगीड|नपददकशोर|ननददकशोर|ननदकता|शीदकशन|सुखदेवदेवी|पतरसल|रयनहत|रोनहत|धमारराम|अमाचपद|अपकुर|पुरोनहत/;

  const voters = await mongoose.connection.db.collection('voters')
    .find({
      organizationId: khetaId,
      $or: [
        { nameHi: { $regex: CORRUPT_REGEX } },
        { relativeNameHi: { $regex: CORRUPT_REGEX } },
        { wardNo: '1', serialNo: { $gte: 111, $lte: 117 } }
      ]
    })
    .toArray();

  console.log(`Found ${voters.length} records to process in Kheta Ram.`);

  let updatedCount = 0;
  for (const v of voters) {
    let newNameHi = cleanSpecific(v.nameHi);
    let newRelHi = cleanSpecific(v.relativeNameHi);
    let newCaste = v.caste || '';

    // Ward 1 House 35 Cards 111-117
    if (v.wardNo === '1') {
      if (v.serialNo === 111) { newNameHi = 'जेठमल जांगिड़'; newRelHi = 'सुखदेव जांगिड़'; newCaste = 'जांगिड़'; }
      if (v.serialNo === 112) { newNameHi = 'पतासी'; newRelHi = 'जेठमल जांगिड़'; newCaste = 'जांगिड़'; }
      if (v.serialNo === 113) { newNameHi = 'कमलकिशोर जांगिड़'; newRelHi = 'जेठमल जांगिड़'; newCaste = 'जांगिड़'; }
      if (v.serialNo === 114) { newNameHi = 'निर्मल कुमार जांगिड़'; newRelHi = 'जेठमल जांगिड़'; newCaste = 'जांगिड़'; }
      if (v.serialNo === 115) { newNameHi = 'अंजू जांगिड़'; newRelHi = 'निर्मल कुमार जांगिड़'; newCaste = 'जांगिड़'; }
      if (v.serialNo === 116) { newNameHi = 'रोहित कुमार जांगिड़'; newRelHi = 'जेठमल जांगिड़'; newCaste = 'जांगिड़'; }
      if (v.serialNo === 117) { newNameHi = 'मंजू जांगिड़'; newRelHi = 'कमलकिशोर जांगिड़'; newCaste = 'जांगिड़'; }
    }

    // Fix सुखदेवदेवी when relative
    if (newRelHi === 'सुखदेवदेवी') {
      newRelHi = (newNameHi.includes('जांगिड़') || newRelHi.includes('जांगिड़')) ? 'सुखदेव जांगिड़' : 'सुखदेव';
    }
    if (newNameHi === 'सुखदेवदेवी') {
      newNameHi = (v.gender === 'स्त्री') ? 'सुखदेव देवी' : 'सुखदेव';
    }

    // Auto-detect caste if caste was empty and name or relative clearly has it
    if (!newCaste) {
      if (newNameHi.includes('जांगिड़') || newRelHi.includes('जांगिड़')) newCaste = 'जांगिड़';
      else if (newNameHi.includes('शर्मा') || newRelHi.includes('शर्मा') || newNameHi.includes('पुरोहित') || newRelHi.includes('पुरोहित')) newCaste = 'ब्राह्मण / शर्मा';
      else if (newNameHi.includes('प्रजापत') || newRelHi.includes('प्रजापत')) newCaste = 'प्रजापत (कुम्हार)';
      else if (newNameHi.includes('गौड़') || newRelHi.includes('गौड़')) newCaste = 'गौड़ ब्राह्मण';
      else if (newNameHi.includes('नाई') || newRelHi.includes('नाई')) newCaste = 'नाई (सेन)';
      else if (newNameHi.includes('बलारा') || newRelHi.includes('बलारा')) newCaste = 'जाट';
      else if (newNameHi.includes('चौधरी') || newRelHi.includes('चौधरी')) newCaste = 'जाट (चौधरी)';
    }

    const newNameEn = toEnglish(newNameHi, v.nameEn);
    const newRelEn = toEnglish(newRelHi, v.relativeNameEn);

    const updateFields = {
      nameHi: newNameHi,
      nameEn: newNameEn,
      relativeNameHi: newRelHi,
      relativeNameEn: newRelEn,
      caste: newCaste
    };

    await mongoose.connection.db.collection('voters').updateOne(
      { _id: v._id },
      { $set: updateFields }
    );
    updatedCount++;
    console.log(`Updated [W${v.wardNo} #${v.serialNo}]: NameHi="${newNameHi}", NameEn="${newNameEn}", RelHi="${newRelHi}", RelEn="${newRelEn}", Caste="${newCaste}"`);
  }

  console.log(`\nSuccessfully updated ${updatedCount} records in Kheta Ram tenant.`);
  await mongoose.disconnect();
}

run().catch(console.error);

