# Gujarati scanned rolls (with voter photos)

The Gujarat ECI final rolls (`2026-EROLLGEN-...-GUJ-<part>.pdf`) are image-only PDFs at about
115 dpi. There is no text layer, and Tesseract `guj` cannot read them reliably, so the names
are read from review sheets and the photos are cut automatically.

## 1. Cut cards and photos

```bash
python3 -I scripts/gujarati_roll/roll_cards.py --pdf roll.pdf --out work/part84
```

Output: `cards/`, `photos/<serial>.webp`, `review/p<page>_<half>.png` (15 cards per sheet) and
`manifest.json`. Serials follow card order, so check that the count printed matches the last
serial on the roll's cover page (for example, 1169 for part 84).

## 2. Transcribe to TSV

One line per voter, tab separated, exactly as printed on the card:

```
serial  flag  epic  name  rel  relative  house  age  gender
1       	TMW2336147	સાહિદાબાનુ મેમણ	H	મહમંદઅસ્લમ મૈમણ	00	30	F
```

- `flag`: blank, `#` (corrected), or `S`/`E`/`R`/`M`/`Q` for cards stamped DELETED. Deleted cards are skipped on import.
- `rel`: `F` father (પિતા), `H` husband (પતિ), `M` mother, `O` other (અન્ય).
- `gender`: `M` or `F`.
- House numbers in Gujarati digits are written as ASCII digits (`૧-૧૯-૩` → `1-19-3`).

Check the result against the cover and summary pages: total, male, female and deleted counts.

## 3. Import into the client

```bash
node scripts/gujarati_roll/import_roll.js \
  --org tenant_c6f65ce9-2547-4b16-8dc3-76c460fc2230 --part 84 --ward 1 \
  --section "1-ચારવાસ, મુ.પો.વાવ" \
  --booth "રાઠોડ વાસ પ્રાથમિક શાળા નું મકાન, રૂમ નં -3, વાવ" \
  --tsv part84.tsv --photos work/part84/photos --dry-run
```

Drop `--dry-run` to write. Voters are upserted by (org, part, serial), so the import can be
re-run safely. Photos go into the `voterphotos` collection and are linked as
`PUBLIC_URL/media/vp/<id>.webp`, which `index.js` serves. Because they live in MongoDB, no
frontend deploy is needed for new photos.

Each voter's caste is set from the surname (last word of the name). Spelling variants are
merged (`lib/gujaratiCaste.js`), and the client's caste list is rebuilt, ordered by voter count.

Photos then show up automatically wherever a voter has one: the voter card, the slip, the
family slip, the poll-desk print/PDF, and both Excel exports (embedded).
