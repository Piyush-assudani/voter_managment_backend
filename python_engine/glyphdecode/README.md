# Glyph-exact electoral roll engine (Engine 0)

## Why the old engines were inaccurate

SEC Rajasthan (and many ECI) roll PDFs do have a text layer, but its
**ToUnicode map is broken**: many different Devanagari glyphs map to the same
wrong character. For example, `ा`, `व` and `र` all come out as `र`, so
"राज्य निर्वाचन आयोग" is extracted as "ररजज ननरररचन आजयग". That information
is lost, and no text converter, dictionary or AI repair can get it back
reliably.

The **glyph shapes** inside the embedded font are still the original ones,
so this engine ignores the text layer and reads the glyphs:

1. Hash each embedded glyph's outline (`glyph_hash.py`).
2. Look up the hash in `fonts/*.json` to get the exact Unicode for that glyph,
   including conjuncts like `क्ष`, `त्र`, `ड्ड`, reph, `िं`.
3. Reorder from visual to logical order (pre-base `ि`, reph `र्`) in
   `glyph_decoder.logical_order`.
4. Parse cards by layout (`roll_extractor.py`): serial, EPIC, name,
   relation, house, age, gender, E/S/R deletion marker, locality heading,
   photo, and the supplements (परिवर्धन / विलोपन / संशोधन).
5. **Self-verify** against the numbers printed in the PDF: cover totals
   (total, male, female, last serial), supplement section counts, contiguous
   serials, and complete fields. The result is in the `verification` JSON.

There's no OCR and no guessing. On the 17 sample PDFs (4,783 voters), every
check passes and 40 random cards compared by eye match the printed PDF
exactly.

## Usage

```bash
python3 roll_extractor.py --pdf roll.pdf --output roll.xlsx \
    [--ward 1] [--booth 13] [--extract-photos-dir photos/] [--include-deleted] [--json roll.json]
```

The last stdout line is JSON: `{"success", "count", "verified", "verification": {...}}`.

| Exit | Meaning | What `lib/pythonBridge.js` does |
|---|---|---|
| 0 | extracted | uses it (`engineUsed: 'glyph_exact'`) |
| 3 | no text layer (scanned PDF) | falls back to Engine 1/2 (OCR) |
| 4 | no voter cards recognised (unknown layout) | falls back |
| 5 | embedded font not in the glyph DB | falls back, see below |

## Adding a new font (when a PDF exits with `unknown_font`)

Find the font name the PDF uses:

```bash
python3 -c "import fitz,sys; d=fitz.open(sys.argv[1]); print({f[3] for p in d for f in p.get_fonts()})" roll.pdf
```

Get that `.ttf` file (for example Mangal or Nirmala UI from a Windows machine,
or Noto Sans Devanagari), then build its DB once:

```bash
python3 build_glyph_db.py /path/to/Mangal.ttf fonts/mangal.json
```

The builder shapes about 23k synthetic syllables with the real font through
MuPDF's HarfBuzz engine, learns each glyph's text, walks GSUB for the
remaining ligatures, and prints a self-test (`self-test failures` should be
only impossible forms such as `र्र्क`). The JSON holds only outline hashes, not
font data, so it is safe to commit. Every `fonts/*.json` is loaded
automatically.

Currently included: `arial_unicode.json` (Arial Unicode MS, used by SEC
Rajasthan panchayat rolls).

## Notes

- Text is kept exactly as printed, including source spellings such as
  `पुरूष` (the gender column is normalised to `पुरुष`) and joined names like
  `मोटाराम`. `workers/pdfWorker.js` skips `fixCorruptedHindi` and gender
  guessing for this engine.
- Deleted voters (E = death, S = shifted, R = repetition) are left out by
  default, which matches the old engine. Pass `--include-deleted` to keep
  them, with `status = Deleted` and the reason in the `टिप्पणी` column.
- Corrections (घटक 3 संशोधन) overwrite the original card's fields, and
  additions (घटक 1) are appended.
