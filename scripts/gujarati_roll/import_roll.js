/**
 * Load a transcribed Gujarati roll (plus its photos) into one client.
 *
 *   node scripts/gujarati_roll/import_roll.js \
 *     --org tenant_xxx --part 84 --ward 1 \
 *     --section "1-ચારવાસ, મુ.પો.વાવ" \
 *     --booth "રાઠોડ વાસ પ્રાથમિક શાળા નું મકાન, રૂમ નં -3, વાવ" \
 *     --tsv voters.tsv --photos work/photos [--dry-run]
 *
 * TSV columns (tab separated, one voter per line):
 *   serial  flag  epic  name  rel  relative  house  age  gender
 *   flag: '' | '#' (corrected) | S/E/R/M/Q (deleted -> skipped)
 *   rel: F father, H husband, M mother, O other;  gender: M / F
 *
 * Voters are upserted by (org, part, serial), so re-running is safe. Each photo is
 * stored (WebP) in the voterphotos collection and linked as PUBLIC_URL/media/vp/<id>.webp.
 */
require('dotenv').config({ quiet: true, path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
require('../../models');
const { casteFromName } = require('../../lib/gujaratiCaste');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--dry-run') args.dryRun = true;
  else if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
}
for (const k of ['org', 'part', 'ward', 'tsv']) {
  if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
}

const REL = { F: 'पिता', H: 'पति', M: 'माता', O: 'अन्य' };
const DELETED = new Set(['S', 'E', 'R', 'M', 'Q']);
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://vijaysetu.piyushassudani.in').replace(/\/+$/, '');

function readRows(file) {
  const rows = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, n) => {
    if (!line.trim()) return;
    const p = line.replace(/\r$/, '').split('\t').map((x) => x.normalize('NFC').trim());
    if (p.length !== 9) throw new Error(`line ${n + 1}: expected 9 columns, got ${p.length}`);
    const [serial, flag, epic, name, rel, relName, house, age, gender] = p;
    if (!/^\d+$/.test(serial) || !REL[rel] || !['M', 'F'].includes(gender) || !/^\d+$/.test(age)) {
      throw new Error(`line ${n + 1}: bad value in "${line}"`);
    }
    rows.push({ serial: +serial, flag, epic, name, rel, relName, house, age: +age, gender });
  });
  return rows;
}

(async () => {
  const rows = readRows(args.tsv);
  const serials = rows.map((r) => r.serial);
  const dupes = serials.filter((s, i) => serials.indexOf(s) !== i);
  if (dupes.length) throw new Error(`duplicate serials: ${dupes.join(',')}`);

  await mongoose.connect(process.env.MONGO_URI);
  const Voter = mongoose.model('Voter');
  const VoterPhoto = mongoose.model('VoterPhoto');
  const Organization = mongoose.model('Organization');
  const org = await Organization.findById(args.org).lean();
  if (!org) throw new Error(`organization ${args.org} not found`);

  let inserted = 0, updated = 0, skipped = 0, photos = 0;
  // Caste = surname (last word of the name); spelling variants reuse an existing caste name.
  const knownCastes = Array.isArray(org.casteOptions) ? [...org.casteOptions] : [];
  for (const r of rows) {
    if (DELETED.has(r.flag)) { skipped++; continue; }
    const filter = { organizationId: args.org, partNo: String(args.part), serialNo: r.serial };
    const existing = await Voter.findOne(filter).select('_id photoUrl').lean();
    const voterId = existing?._id || `voter_${crypto.randomUUID()}`;
    const fields = {
      epic: r.epic, wardNo: String(args.ward), partNo: String(args.part), serialNo: r.serial,
      nameEn: r.name, nameHi: r.name, age: r.age, gender: r.gender === 'M' ? 'पुरुष' : 'स्त्री',
      relationType: REL[r.rel], relativeNameEn: r.relName, relativeNameHi: r.relName,
      houseNo: r.house, houseNoHi: r.house,
      villageName: args.section || '', villageNameHi: args.section || '', boothName: args.booth || '',
      familyId: `FAM_W${args.ward}_P${args.part}_H${r.house.replace(/\s+/g, '')}`,
      caste: casteFromName(r.name, knownCastes),
      organizationId: args.org,
    };

    let photoUrl = existing?.photoUrl || '';
    const photoFile = args.photos && [5, 4].map((d) => path.join(args.photos, `${String(r.serial).padStart(d, '0')}.webp`)).find((f) => fs.existsSync(f));
    if (photoFile) {
      const m = /\/media\/vp\/([a-f0-9]{32})\.(?:jpg|webp)$/.exec(photoUrl);
      const photoId = m ? m[1] : crypto.randomBytes(16).toString('hex');
      if (!args.dryRun) {
        await VoterPhoto.updateOne(
          { _id: photoId },
          { $set: { organizationId: args.org, voterId, contentType: 'image/webp', data: fs.readFileSync(photoFile) } },
          { upsert: true }
        );
      }
      photoUrl = `${PUBLIC_URL}/media/vp/${photoId}.webp`;
      photos++;
    }
    fields.photoUrl = photoUrl;

    if (!args.dryRun) {
      if (existing) await Voter.updateOne({ _id: voterId }, { $set: fields });
      else await Voter.create({ _id: voterId, ...fields, mobileNo: '', caste: '', supportStatus: 'unmarked', status: 'Active' });
    }
    if (fields.caste && !knownCastes.includes(fields.caste)) knownCastes.push(fields.caste);
    existing ? updated++ : inserted++;
  }

  if (!args.dryRun) {
    const wards = new Set([...(org.wards || []), String(args.ward)]);
    // Caste options ordered by how many voters each caste has in this client.
    const counts = await Voter.aggregate([
      { $match: { organizationId: args.org, caste: { $nin: [null, ''] } } },
      { $group: { _id: '$caste', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
    await Organization.updateOne(
      { _id: args.org },
      { $set: { wards: [...wards], casteOptions: counts.map((c) => c._id) } }
    );
  }
  console.log(JSON.stringify({ dryRun: !!args.dryRun, inserted, updated, skippedDeleted: skipped, photos }));
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
