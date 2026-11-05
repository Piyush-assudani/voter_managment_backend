const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');
const { performLocalOCR, cleanHindiText, cleanHouseNo } = require('../lib/ocrService');
const { isKrutiDevText, convertKrutiDevToUnicode, autoConvertText, isPUAText } = require('../lib/krutiDevConverter');
const { fixCorruptedHindi } = require('../lib/hindiDictionary');
const { fuzzyCorrectName, cleanVillageOrSectionName, predictCaste } = require('../lib/fuzzyNameMatcher');

function levenshtein(s1, s2) {
  if (s1.length < s2.length) return levenshtein(s2, s1);
  if (s2.length === 0) return s1.length;
  let prev = Array.from({ length: s2.length + 1 }, (_, i) => i);
  for (let i = 0; i < s1.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < s2.length; j++) {
      const ins = prev[j + 1] + 1;
      const del = curr[j] + 1;
      const sub = prev[j] + (s1[i] === s2[j] ? 0 : 1);
      curr.push(Math.min(ins, del, sub));
    }
    prev = curr;
  }
  return prev[s2.length];
}

function stripNameFromRelative(voterName, relName) {
  if (!voterName || !relName) return relName || '';
  let vn = String(voterName).trim();
  let rn = String(relName).trim();
  if (!rn || !vn) return rn;

  const HONORIFIC_SUFFIXES = new Set(['राम', 'देवी', 'लाल', 'सिंह', 'कुमार', 'कुमारी', 'बाई', 'प्रसाद', 'दास', 'चंद', 'चन्द', 'नाथ', 'कंवर']);

  // 1. Exact full voter name prefix match
  if (rn.startsWith(vn) && rn.length > vn.length) {
    const remainder = rn.slice(vn.length).trim();
    if (remainder.length >= 3 && !HONORIFIC_SUFFIXES.has(remainder)) {
      return remainder;
    }
  }

  // 2. Token match: Only if voter has 2+ words and rel begins with ALL of them
  const vnTokens = vn.split(/\s+/).filter(Boolean);
  const rnTokens = rn.split(/\s+/).filter(Boolean);
  if (vnTokens.length >= 2 && rnTokens.length > vnTokens.length) {
    let allMatch = true;
    for (let i = 0; i < vnTokens.length; i++) {
      if (rnTokens[i] !== vnTokens[i]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      const remainder = rnTokens.slice(vnTokens.length).join(' ').trim();
      if (remainder.length >= 3 && !HONORIFIC_SUFFIXES.has(remainder)) {
        return remainder;
      }
    }
  }

  // Safe guard: Never strip father's first name just because it rhymes/is similar with voter!
  return rn;
}

const SURNAMES_FOR_HOUSE_MATCH = new Set([
  'चौधरी', 'सिंह', 'कंवर', 'सियाग', 'सेवर', 'फंगाल', 'पिन्डे ल', 'पिन्डेल', 'बिश्नोई',
  'जाट', 'मेघवाल', 'कुम्हार', 'शर्मा', 'वर्मा', 'सुथार', 'गोदारा', 'सारण', 'बेनीवाल',
  'खत्री', 'देवी', 'बाई', 'कुमार', 'राम'
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

    const sNum = typeof v.serialNo === 'number' ? v.serialNo : parseInt(v.serialNo, 10) || 0;
    const relName = (v.relativeNameHi || '').trim();
    const baseRel = getBaseDevanagariName(relName);
    if (!baseRel) continue;

    const candidates = [];
    for (const cand of validPool) {
      const cBaseName = getBaseDevanagariName(cand.nameHi);
      const cSNum = typeof cand.serialNo === 'number' ? cand.serialNo : parseInt(cand.serialNo, 10) || 0;
      const dist = Math.abs(cSNum - sNum);

      // Priority 1: Direct spouse or parent match
      if (baseRel === cBaseName || baseRel.includes(cBaseName) || cBaseName.includes(baseRel)) {
        candidates.push({ dist, priority: 1, houseNo: cand.houseNo });
      }
      // Priority 2: Relative's relative match (sibling/parent)
      const cRelName = getBaseDevanagariName(cand.relativeNameHi);
      if (cRelName && (baseRel === cRelName || baseRel.includes(cRelName) || cRelName.includes(baseRel))) {
        candidates.push({ dist, priority: 2, houseNo: cand.houseNo });
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => a.priority - b.priority || a.dist - b.dist);
      v.houseNo = candidates[0].houseNo;
      v.houseNoHi = candidates[0].houseNo;
    }
  }

  // 4. Final pass: Any remaining empty is clean '-'
  for (const v of voterList) {
    if (!v.houseNo || v.houseNo === '0' || v.houseNo === '00') {
      v.houseNo = '-';
      v.houseNoHi = '-';
    }
  }

  return voterList;
}

async function processPdf() {
  const { filePath, useOcr, organizationId, wardNo, boothNo, panchayat, uploadedBy, withPhotos, jobId } = workerData;
  let text = "";

  const updateProgress = (prog, stageMsg = 'प्रोसेसिंग जारी है...') => {
    if (parentPort) {
      parentPort.postMessage({ type: 'progress', data: prog, stage: stageMsg });
    }
  };

  try {
    updateProgress(5, '📄 PDF फ़ाइल लोड और सत्यापन प्रारंभ...');
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);
    text = pdfData.text || "";
    if (isKrutiDevText(text) || isPUAText(text)) {
      text = autoConvertText(text);
    }
    updateProgress(15, '🔍 हेडर और फॉन्ट संरचना का विश्लेषण...');

const { runPythonPdfToExcel, isPythonAvailable } = require('../lib/pythonBridge');
const { uploadVoterPhotosBatch } = require('../lib/cloudinaryService');
const ExcelJS = require('exceljs');

    // Extract metadata from header, SEC encoded text, or filename
    const partMatch = text.match(/(?:भाग|Part|भरग)\s*(?:संख्या|No|क्रं|No\.)?\s*[:\-]?\s*(\d+)/i) ||
                      text.match(/(?:मतदरन\s*बबस|मतदान\s*केंद्र|मतदान\s*स्थल).*?(\d+)\s*[-–]/s);
    const wardMatch = text.match(/(?:वार्ड|Ward|रररर|ररडर)\s*(?:संख्या|No|क्रं|No\.|कमरपक|कमररक)?\s*[:\-]?\s*(\d+)/i) ||
                      filePath.match(/Ward\s*(?:No)?[_\-\s]*0*(\d+)/i);
    const defaultPartNo = boothNo || (partMatch ? partMatch[1] : "1");
    const defaultWardNo = wardNo || (wardMatch ? wardMatch[1] : "1");

    // Extract all vector EPICs from digital PDF text stream (strictly requires numbers)
    const epicRegex = /[A-Z]{3}[0-9]{7}|[A-Z]{2,4}[0-9]{6,8}|[A-Z]{2,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{3,7}/gi;
    let match;
    const vectorEpics = [];
    const seenEpics = new Set();
    while ((match = epicRegex.exec(text)) !== null) {
      const cleanEpic = match[0].replace(/\s+/g, '').toUpperCase();
      if (!seenEpics.has(cleanEpic)) {
        seenEpics.add(cleanEpic);
        vectorEpics.push(cleanEpic);
      }
    }

    let finalVoterList = [];
    let usedPythonEngine = false;
    let targetExcelPath = null;
    let excelFilename = null;

    // 1. High-Performance Native Python Engine (if available)
    let pythonErrorMsg = null;
    const pythonOk = await isPythonAvailable();
    console.log(`[pdfWorker] Python availability check: ${pythonOk}`);
    if (pythonOk) {
      console.log(`[pdfWorker] Using native multi-threaded Python engine for PDF extraction: ${filePath}`);
      updateProgress(20, '⚙️ पायथन 7-पिलर इंजन द्वारा PDF से उच्च-सटीक Excel तालिका जनरेट की जा रही है...');
      const path = require('path');
      excelFilename = `${path.basename(filePath, path.extname(filePath))}_converted.xlsx`;
      const excelDir = path.join(__dirname, '../uploads/excels');
      if (!fs.existsSync(excelDir)) fs.mkdirSync(excelDir, { recursive: true });
      targetExcelPath = path.join(excelDir, excelFilename);

      const photosDir = withPhotos !== false ? path.join(__dirname, '../uploads/photos', jobId || `job_${Date.now()}`) : null;
      if (photosDir && !fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });
      const photoUrlMap = new Map();

      try {
        const pyResult = await runPythonPdfToExcel(filePath, targetExcelPath, wardNo || defaultWardNo, boothNo || '', photosDir);
        console.log(`[pdfWorker] Python engine finished successfully:`, pyResult);

        // Upload extracted photos to Cloudinary automatically
        if (withPhotos !== false && photosDir && fs.existsSync(photosDir)) {
          const manifestPath = path.join(photosDir, 'photos_manifest.json');
          if (fs.existsSync(manifestPath)) {
            try {
              const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
              const uploadItems = manifest
                .filter(item => item.photo_file && fs.existsSync(path.join(photosDir, item.photo_file)))
                .map(item => {
                  const safeId = (item.epic || `voter_${item.serial}`).replace(/[^a-zA-Z0-9_\-]/g, '_');
                  return {
                    filePath: path.join(photosDir, item.photo_file),
                    publicId: `${organizationId || 'org'}_w${wardNo || defaultWardNo}_s${item.serial}_${safeId}`,
                    epic: item.epic,
                    serial: item.serial
                  };
                });

              if (uploadItems.length > 0) {
                updateProgress(50, `📸 ${uploadItems.length} मतदाता फोटो क्लाउड (Cloudinary) में सुरक्षित किए जा रहे हैं...`);
                const uploadedMap = await uploadVoterPhotosBatch(uploadItems, 15, (done, total) => {
                  const prog = 50 + Math.floor((done / total) * 15);
                  updateProgress(prog, `📸 फोटो क्लाउड में सुरक्षित हो रहे हैं (${done}/${total})...`);
                });

                uploadItems.forEach(item => {
                  const url = uploadedMap.get(item.publicId);
                  if (url) {
                    if (item.epic) photoUrlMap.set(item.epic, url);
                    if (item.serial) photoUrlMap.set(String(item.serial), url);
                  }
                });
                console.log(`[pdfWorker] Successfully uploaded ${uploadedMap.size} photos to Cloudinary`);
              }
            } catch (pErr) {
              console.warn('[pdfWorker] Photo upload warning:', pErr.message);
            } finally {
              try {
                fs.rmSync(photosDir, { recursive: true, force: true });
              } catch {}
            }
          }
        }

        updateProgress(65, '📊 जनरेट की गई Excel तालिका से सत्यापित मतदाता डेटा लोड हो रहा है...');
        
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(targetExcelPath);
        const worksheet = workbook.getWorksheet('Voters') || workbook.getWorksheet('मतदाता सूची') || workbook.worksheets[0];
        
        // Dynamically map column headers for robust universal parsing (supports Sheet 1 'Voters' & Sheet 2 'मतदाता सूची')
        const headerRow = worksheet.getRow(1);
        const colMap = {};
        const isHi = (str) => str.includes('hindi') || str.includes('hin') || str.includes('हिंदी') || str.includes('हिन्दी');
        const isEn = (str) => str.includes('english') || str.includes('eng') || str.includes('(en)') || str.endsWith('en');

        headerRow.eachCell((cell, colNumber) => {
          const rawVal = String(cell.value || '').trim();
          const h = rawVal.toLowerCase().replace(/[\s\-_()\/.,]/g, '');
          if (!h) return;

          if (/^(क्रमांक|serial|srno|sno|serialno|अनुक्रमांक|slno)$/i.test(h) || h.startsWith('serial') || h.startsWith('क्रमांक')) {
            if (!colMap.serialNo) colMap.serialNo = colNumber;
          } else if (/^(पहचान|पहचानपत्र|epic|epicno|voterid|पहचानपत्रepicno)$/i.test(h) || h.includes('epic') || h.startsWith('पहचान')) {
            if (!colMap.epic) colMap.epic = colNumber;
          } else if (h.includes('नाम') || h.includes('name')) {
            if (h.includes('संबंधी') || h.includes('पिता') || h.includes('पति') || h.includes('relative') || h.includes('father') || h.includes('husband')) {
              if (isEn(h)) colMap.relativeNameEn = colNumber;
              else colMap.relativeNameHi = colNumber;
            } else if (isEn(h)) {
              colMap.nameEn = colNumber;
            } else {
              colMap.nameHi = colNumber;
            }
          } else if (/^(संबंध|सम्बन्ध|संबंधप्रकार|relation|relationtype|रिश्ता)$/i.test(h) || h.startsWith('संबंध') || h.startsWith('relation')) {
            colMap.relationType = colNumber;
          } else if (/^(मकान|मकानसंख्या|गृहसंख्या|houseno|house|मकाननं)$/i.test(h) || h.startsWith('house') || h.startsWith('मकान')) {
            if (isHi(h)) colMap.houseNoHi = colNumber;
            else if (!colMap.houseNo) colMap.houseNo = colNumber;
          } else if (/^(आयु|age|उम्र|voterage)$/i.test(h)) {
            colMap.age = colNumber;
          } else if (/^(लिंग|gender|sex|जेंडर)$/i.test(h)) {
            colMap.gender = colNumber;
          } else if (/^(स्थिति|status)$/i.test(h)) {
            colMap.status = colNumber;
          } else if (/^(वार्ड|ward|wardno|वार्डसंख्या)$/i.test(h) || h.startsWith('ward') || h.startsWith('वार्ड')) {
            colMap.wardNo = colNumber;
          } else if (/^(बूथ|भाग|part|booth|partno|boothno|भागसंख्या|बूथसंख्या)$/i.test(h) || h.startsWith('part') || h.startsWith('booth') || h.includes('भागसंख्या')) {
            colMap.partNo = colNumber;
          } else if (/^(गाँव|गांव|village|villagename|ग्राम|मोहल्ला)$/i.test(h) || h.startsWith('village') || h.startsWith('गांव') || h.startsWith('गाँव')) {
            if (isHi(h)) colMap.villageNameHi = colNumber;
            else if (!colMap.villageName) colMap.villageName = colNumber;
          } else if (/^(पंचायत|ग्रामपंचायत|panchayat|grampanchayat)$/i.test(h) || h.startsWith('panchayat') || h.startsWith('पंचायत')) {
            colMap.panchayat = colNumber;
          }
        });

        const isDevanagariSheet = (worksheet.name && worksheet.name.includes('मतदाता')) ||
          (worksheet.getRow(1).getCell(1).value && String(worksheet.getRow(1).getCell(1).value).includes('क्रमांक'));
        
        const fallbackCol = isDevanagariSheet ? {
          serialNo: 1,
          epic: 2,
          nameHi: 3,
          relativeNameHi: 4,
          relationType: 5,
          houseNo: 6,
          age: 7,
          gender: 8,
          villageName: 9,
          wardNo: 10,
          partNo: 11,
          status: 12
        } : {
          epic: 1,
          wardNo: 2,
          partNo: 3,
          serialNo: 4,
          nameEn: 5,
          nameHi: 6,
          age: 7,
          gender: 8,
          relationType: 9,
          relativeNameEn: 10,
          relativeNameHi: 11,
          houseNo: 12,
          villageName: 17
        };

        const cellVal = (row, key, fallbackIdx) => {
          const idx = colMap[key] || fallbackIdx;
          if (!idx) return '';
          const cell = row.getCell(idx);
          if (cell && cell.value !== undefined && cell.value !== null) {
            if (typeof cell.value === 'object' && cell.value.result !== undefined) return String(cell.value.result).trim();
            if (typeof cell.value === 'object' && cell.value.text !== undefined) return String(cell.value.text).trim();
            return String(cell.value).trim();
          }
          return '';
        };

        function cleanLabelAndEpic(str) {
          if (!str) return '';
          let s = String(str).trim();
          s = s.replace(/^(?:मतदाता\s*(?:का|कर|कप)?\s*)?(?:नाम|नरम|नपम)\s*[:ः\-]\s*/gi, '');
          s = s.replace(/^(?:पिता|पति|माता|अन्य|पनत|नपतर|मरतर|नपतपकपनपम|पनतकपनपम|नपतपकप|पनतकप)\s*(?:का|कर|कप)?\s*(?:नाम|नरम|नपम)?\s*[:ः\-]\s*/gi, '');
          s = s.replace(/^(?:नपम|नरम)\s*[:ः\-]?\s+/gi, '');
          s = s.replace(/^नाम\s*[:ः\-]\s*/gi, '');
          s = s.replace(/^(?:नपतपकपनपम|पनतकपनपम|नपतपकप|पनतकप|नपतर|पनत|मरतर)\s*[:ः\-]?\s*/gi, '');
          s = s.replace(/\b(?:RJ\/\d{2}\/\d{3}\/\d{6}|[A-Z]{2,3}\d{6,7})\b/gi, '');
          s = s.replace(/\b[A-Z]{2,4}\b/g, '');
          return s.replace(/\s+/g, ' ').trim();
        }

        function isGarbageName(name) {
          if (!name || name.trim().length < 2) return true;
          const n = name.trim();
          if (/^(मतदाता|निर्वाचक|क्रेकक|ई-मेल|email|photo|available|अनज|नपम|नरम)$/i.test(n)) return true;
          if (/(?:लिंग|लीग|आयु|आखद|मकान|वार्ड|बूथ|विधानसभा|पदाष)/i.test(n)) return true;
          return false;
        }
        
        worksheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return; // header
          const rawSerial = cellVal(row, 'serialNo', fallbackCol.serialNo);
          const serialVal = rawSerial ? parseInt(rawSerial, 10) : null;
          const epic = cellVal(row, 'epic', fallbackCol.epic);
          const rawName = cellVal(row, 'nameHi', fallbackCol.nameHi);
          const cleanName = rawName ? fixCorruptedHindi(cleanLabelAndEpic(rawName)) : '';

          const rowWard = cellVal(row, 'wardNo', fallbackCol.wardNo) || wardNo || defaultWardNo || '1';
          const rowBooth = cellVal(row, 'partNo', fallbackCol.partNo) || boothNo || defaultPartNo || '1';
          const rowPanchayat = cellVal(row, 'panchayat') || panchayat || '';

          // STRICT VALIDATION: Check if authentic voter name OR if marked deleted/unreadable
          if (cleanName && !isGarbageName(cleanName)) {
            const rawNameEn = cellVal(row, 'nameEn', fallbackCol.nameEn);
            const rawRel = cellVal(row, 'relativeNameHi', fallbackCol.relativeNameHi);
            let cleanRel = rawRel ? fixCorruptedHindi(cleanLabelAndEpic(rawRel)) : '';
            if (isGarbageName(cleanRel)) cleanRel = '';
            cleanRel = stripNameFromRelative(cleanName, cleanRel);
            const rawRelEn = cellVal(row, 'relativeNameEn', fallbackCol.relativeNameEn);
            const cleanH = cleanHouseNo(cellVal(row, 'houseNo', fallbackCol.houseNo));
            const finalHouse = (cleanH && cleanH !== '0' && cleanH !== '00') ? cleanH : '-';
            const finalNameEn = (rawNameEn && /^[a-zA-Z\s\.\-]+$/.test(String(rawNameEn).trim())) ? String(rawNameEn).trim() : cleanName;
            const finalRelEn = (rawRelEn && /^[a-zA-Z\s\.\-]+$/.test(String(rawRelEn).trim())) ? String(rawRelEn).trim() : (cleanRel.length >= 2 ? cleanRel : (rawRel || ''));
            
            const rawAge = cellVal(row, 'age', fallbackCol.age);
            let ageVal = rawAge ? parseInt(rawAge, 10) : null;
            if (!ageVal || ageVal < 18 || ageVal > 125) ageVal = null;
            
            let relType = cellVal(row, 'relationType', fallbackCol.relationType);
            if (!['पिता', 'पति', 'माता', 'अन्य'].includes(relType)) {
              if (rawRel && /पति|पनत|पनतकपनपम|पनतकप/.test(rawRel)) {
                relType = 'पति';
              } else if (rawRel && /माता|मरतर/.test(rawRel)) {
                relType = 'माता';
              } else {
                relType = 'पिता';
              }
            }
            
            let genderVal = cellVal(row, 'gender', 8);
            if (relType === 'पति') {
              genderVal = 'स्त्री';
            } else if (['देवी', 'कुमारी', 'बाई', 'बेगम', 'कंवर', 'श्रीमती'].some(fem => cleanName.includes(fem))) {
              genderVal = 'स्त्री';
            } else if (!['पुरुष', 'स्त्री'].includes(genderVal)) {
              genderVal = '';
            }

            const villageEn = cleanVillageOrSectionName(cellVal(row, 'villageName', 17));
            const villageHi = cleanVillageOrSectionName(cellVal(row, 'villageNameHi', 18));
            let statusVal = cellVal(row, 'status') || 'Active';
            if (cleanName.includes('विलोपित') || (epic && epic.includes('विलोपित')) || (rawSerial && String(rawSerial).includes('विलोपित'))) {
              statusVal = 'Deleted';
            }

            const cleanEpic = (epic && epic !== '-' && epic.trim() !== '') ? epic.trim() : `VOTER_W${rowWard}_P${rowBooth}_S${serialVal || (finalVoterList.length + 1)}`;

            // Secondary safety net: Prevent duplicate EPIC entries in finalVoterList
            const existingVoterIdx = (cleanEpic && !cleanEpic.startsWith('VOTER_') && !cleanEpic.startsWith('UNREADABLE_'))
              ? finalVoterList.findIndex(v => v.epic === cleanEpic)
              : -1;

            if (existingVoterIdx !== -1) {
              if (statusVal === 'Deleted') {
                finalVoterList[existingVoterIdx].status = 'Deleted';
              }
              if ((!finalVoterList[existingVoterIdx].houseNo || finalVoterList[existingVoterIdx].houseNo === '-') && finalHouse && finalHouse !== '-') {
                finalVoterList[existingVoterIdx].houseNo = finalHouse;
              }
              if (!finalVoterList[existingVoterIdx].age && ageVal) {
                finalVoterList[existingVoterIdx].age = ageVal;
              }
              return;
            }
            const detectedCaste = cellVal(row, 'caste', 15) || predictCaste({
              nameHi: cleanName,
              relativeNameHi: cleanRel,
              villageNameHi: villageHi
            });

            finalVoterList.push({
              serialNo: serialVal || (finalVoterList.length + 1),
              epic: cleanEpic,
              nameHi: cleanName,
              nameEn: finalNameEn,
              relativeNameHi: cleanRel.length >= 2 ? cleanRel : rawRel,
              relativeNameEn: finalRelEn,
              relationType: relType,
              houseNo: finalHouse,
              age: ageVal,
              gender: genderVal,
              caste: detectedCaste,
              status: statusVal,
              wardNo: String(rowWard).trim(),
              panchayat: String(rowPanchayat).trim(),
              panchayatHi: String(rowPanchayat).trim(),
              partNo: String(rowBooth).trim(),
              villageName: villageHi || villageEn || '',
              villageNameHi: villageHi || villageEn || '',
              photoUrl: photoUrlMap.get(cleanEpic) || photoUrlMap.get(String(serialVal)) || ''
            });
          } else if (serialVal || (epic && epic !== '-' && epic.trim().length >= 4)) {
            // Unreadable / corrupted voter record - capture for review and manual editing
            const cleanH = cleanHouseNo(cellVal(row, 'houseNo', 12));
            const finalHouse = (cleanH && cleanH !== '0' && cleanH !== '00') ? cleanH : '-';
            finalVoterList.push({
              serialNo: serialVal || (finalVoterList.length + 1),
              epic: (epic && epic !== '-' && epic.trim() !== '') ? epic.trim() : `UNREADABLE_W${rowWard}_P${rowBooth}_S${serialVal || (finalVoterList.length + 1)}`,
              nameHi: cleanName || 'अपठनीय मतदाता (संशोधन आवश्यक)',
              nameEn: 'Unreadable Voter',
              relativeNameHi: cellVal(row, 'relativeNameHi', fallbackCol.relativeNameHi) || '',
              relativeNameEn: cellVal(row, 'relativeNameEn', fallbackCol.relativeNameEn) || '',
              relationType: 'पिता',
              houseNo: finalHouse,
              age: null,
              gender: '',
              status: 'Unreadable',
              wardNo: String(rowWard).trim(),
              panchayat: String(rowPanchayat).trim(),
              panchayatHi: String(rowPanchayat).trim(),
              partNo: String(rowBooth).trim(),
              villageName: '',
              villageNameHi: '',
              photoUrl: photoUrlMap.get(epic) || photoUrlMap.get(String(serialVal)) || ''
            });
          }
        });
        if (finalVoterList.length > 0) {
          usedPythonEngine = true;
          console.log(`[pdfWorker] Python engine extracted ${finalVoterList.length} authentic voters with high precision from Excel: ${targetExcelPath}`);
          updateProgress(75, `📊 Excel तालिका से ${finalVoterList.length} मतदाताओं का सत्यापन संपन्न!`);
        }
      } catch (pyErr) {
        console.error("[pdfWorker] Python extraction FAILED:", pyErr.message, pyErr.stack);
        pythonErrorMsg = `पायथन इंजन त्रुटि: ${pyErr.message}`;
        finalVoterList = [];
      }
    } else {
      pythonErrorMsg = 'सर्वर पर Python 3 या आवश्यक लाइब्रेरीज़ (pypdf, openpyxl) उपलब्ध नहीं हैं। कृपया pypdf व openpyxl इंस्टॉल करें।';
    }

    if (finalVoterList.length === 0) {
      if (pythonErrorMsg) {
        throw new Error(pythonErrorMsg);
      }
      throw new Error(`PDF से मतदाता रिकॉर्ड नहीं निकाले जा सके। कृपया सुनिश्चित करें कि फ़ाइल एक मान्य निर्वाचन आयोग (SEC/ECI) मतदाता सूची है।`);
    }

    // Assign generated Excel path (Python engine output is the primary source of truth)
    let generatedExcelPath = targetExcelPath;
    if (!generatedExcelPath || !fs.existsSync(generatedExcelPath)) {
      const path = require('path');
      const { generateVoterExcel } = require('../lib/excelExporter');
      if (!excelFilename) excelFilename = `${path.basename(filePath, path.extname(filePath))}_converted.xlsx`;
      const excelPath = path.join(__dirname, '../uploads/excels', excelFilename);
      try {
        generatedExcelPath = await generateVoterExcel(finalVoterList, excelPath, { 
          wardNo: wardNo || defaultWardNo, 
          boothNo: boothNo || defaultPartNo 
        });
      } catch (excelErr) {
        console.warn("Could not generate Excel file:", excelErr.message);
        if (fs.existsSync(excelPath)) generatedExcelPath = excelPath;
      }
    }

    // 4. Intelligent Family House Number Resolution & Leading-Zero Normalization
    resolveFamilyHouseNumbers(finalVoterList);

    updateProgress(82, '👨‍👩‍👧‍👦 मतदाताओं के पारिवारिक समूह (Family Grouping) तैयार किए जा रहे हैं...');
    const { groupVotersIntoFamilies } = require('../lib/familyService');
    const { families, voterFamilyMap } = groupVotersIntoFamilies(finalVoterList);
    console.log(`[pdfWorker] Successfully grouped ${finalVoterList.length} voters into ${families.length} families.`);

    updateProgress(88, '💾 डेटाबेस में सुरक्षित करने के लिए सत्यापित ऑपरेशन्स तैयार...');

    // Build MongoDB bulkWrite operations
    const operations = finalVoterList
      .filter(v => {
        if (!v) return false;
        if (v.status === 'Unreadable' || v.status === 'Deleted') return true;
        const cleanN = (v.nameHi || '').trim();
        if (!cleanN || cleanN === 'मतदाता' || cleanN.length < 2) return false;
        if (/^(?:विधानसभा|निर्वाचक|नामावली|वार्ड|अनुभाग|प्रारूप|मतदान|हस्ताक्षर|कलेण्डर|भाग|संख्या|ओसियाँ|ग्रामपंचायत|पंचायत|समिति|राजस्थान|आयोग)/i.test(cleanN)) return false;
        return true;
      })
      .map((voter, i) => {
        const serialNumber = voter.serialNo || (i + 1);
        const voterStatus = voter.status || 'Active';

        const targetWard = String(voter.wardNo || wardNo || defaultWardNo || '').trim();
        const targetPart = String(voter.partNo || boothNo || defaultPartNo || '').trim();

        const hClean = cleanHouseNo(voter.houseNo);
        const voterHouse = (hClean && hClean !== '0' && hClean !== '00') ? hClean : '-';
        const voterNameEn = (voter.nameEn && /[a-zA-Z]/.test(voter.nameEn)) ? voter.nameEn : (voter.nameHi || '');
        const voterRelEn = (voter.relativeNameEn && /[a-zA-Z]/.test(voter.relativeNameEn)) ? voter.relativeNameEn : (voter.relativeNameHi || '');

        const voterFamilyId = voter.familyId || voterFamilyMap.get(`${targetWard}_${targetPart}_${serialNumber}`) || '';

        const updateFields = {
          epic: voter.epic,
          serialNo: serialNumber,
          nameHi: voter.nameHi,
          nameEn: voterNameEn,
          relativeNameHi: voter.relativeNameHi,
          relativeNameEn: voterRelEn,
          relationType: voter.relationType,
          houseNo: voterHouse,
          age: voter.age,
          gender: voter.gender,
          caste: voter.caste || predictCaste(voter),
          status: voterStatus,
          wardNo: targetWard,
          panchayat: String(voter.panchayat || panchayat || '').trim(),
          panchayatHi: String(voter.panchayat || panchayat || '').trim(),
          partNo: targetPart,
          villageName: voter.villageNameHi || voter.villageName || '',
          villageNameHi: voter.villageNameHi || ''
        };

        if (voterFamilyId) updateFields.familyId = voterFamilyId;
        if (voter.photoUrl) updateFields.photoUrl = voter.photoUrl;
        if (uploadedBy) updateFields.assignedWorker = uploadedBy;

        // 🚀 STRICT WARD + PART + SERIAL ISOLATION:
        // Anchoring by (organizationId, wardNo, partNo, serialNo) guarantees that:
        // 1. Every voter in this ward roll is uniquely identified by their official serial number.
        // 2. Uploading a ward will NEVER overwrite or steal records from another ward,
        //    even if supplement pages share EPICs across different ward lists.
        // 3. Re-uploading a ward updates all voters in-place without duplicates or count fluctuations.
        const voterFilter = {
          organizationId: organizationId,
          wardNo: targetWard,
          serialNo: serialNumber
        };
        if (targetPart) {
          voterFilter.partNo = targetPart;
        }

        const setOnInsertFields = {
          _id: `voter_${crypto.randomUUID()}`,
          organizationId: organizationId,
          supportStatus: 'unmarked',
          voted: false,
          votedAt: null,
          assignedWorker: uploadedBy || ''
        };

        return {
          updateOne: {
            filter: voterFilter,
            update: {
              $set: updateFields,
              $setOnInsert: setOnInsertFields
            },
            upsert: true
          }
        };
      });

    if (parentPort) {
      parentPort.postMessage({ 
        type: 'done', 
        data: operations, 
        epicsCount: operations.length,
        excelPath: generatedExcelPath,
        excelFilename 
      });
    }

  } catch (err) {
    console.error("PDF extraction error in worker:", err);
    if (parentPort) {
      parentPort.postMessage({ type: 'error', data: err.message });
    }
  }
}

processPdf();
