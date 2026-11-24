/**
 * Helpers for voter photos kept in the voterphotos collection (see /media/vp/:id).
 */
const mongoose = require('mongoose');
const sharp = require('sharp');

const PHOTO_URL_RE = /\/media\/vp\/([a-f0-9]{32})\.(?:jpg|jpeg|webp)$/i;

function photoIdFromUrl(url) {
  const m = typeof url === 'string' ? PHOTO_URL_RE.exec(url) : null;
  return m ? m[1] : null;
}

function hasStoredPhotos(voters) {
  return Array.isArray(voters) && voters.some((v) => photoIdFromUrl(v.photoUrl));
}

/**
 * Add a "Photo" column to an ExcelJS sheet whose rows are in the same order as `voters`
 * (row 1 = header). ExcelJS embeds only JPEG/PNG, so WebP photos are converted in memory.
 */
async function embedVoterPhotos(workbook, sheet, voters, header = 'Photo') {
  const ids = voters.map((v) => photoIdFromUrl(v.photoUrl));
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return;

  const VoterPhoto = mongoose.model('VoterPhoto');
  const byId = new Map();
  for (let i = 0; i < wanted.length; i += 500) {
    const docs = await VoterPhoto.find({ _id: { $in: wanted.slice(i, i + 500) } }).select('data contentType').lean();
    docs.forEach((d) => byId.set(d._id, d));
  }

  // Photos are stored as WebP, which Excel can't show: convert to JPEG in memory only.
  const images = new Map();
  for (const [id, doc] of byId) {
    const buffer = doc.data?.buffer ? Buffer.from(doc.data.buffer) : doc.data;
    try {
      if (/png/i.test(doc.contentType)) images.set(id, { buffer, extension: 'png' });
      else if (/jpe?g/i.test(doc.contentType)) images.set(id, { buffer, extension: 'jpeg' });
      else images.set(id, { buffer: await sharp(buffer).jpeg({ quality: 85 }).toBuffer(), extension: 'jpeg' });
    } catch {
      // skip unreadable photo
    }
  }

  const col = sheet.columnCount + 1;
  sheet.getRow(1).getCell(col).value = header;
  sheet.getColumn(col).width = 10;

  ids.forEach((id, idx) => {
    const doc = id && byId.get(id);
    if (!doc) return;
    const image = images.get(id);
    if (!image) return;
    const imageId = workbook.addImage(image);
    const rowNumber = idx + 2;
    sheet.getRow(rowNumber).height = 62;
    sheet.addImage(imageId, {
      tl: { col: col - 1 + 0.1, row: rowNumber - 1 + 0.05 },
      ext: { width: 48, height: 60 },
      editAs: 'oneCell',
    });
  });
}

module.exports = { photoIdFromUrl, hasStoredPhotos, embedVoterPhotos };
