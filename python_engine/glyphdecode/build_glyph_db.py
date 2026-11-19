#!/usr/bin/env python3
"""
Build a glyph-outline database from a reference Devanagari font (offline, one-time).

Why: Government roll PDFs (SEC Rajasthan, ECI, etc.) embed subset TrueType
fonts whose ToUnicode tables are broken for Devanagari (many different glyphs
map to the same wrong character, e.g. ा/व/र all -> "र"). The glyph *outlines*
are still identical to the original font, so we learn "outline hash -> text"
once from the real font and decode PDFs by shape. No OCR, no guessing.

How the mapping is learnt:
  * cmap gives base characters.
  * A synthetic corpus (~15k syllables: every consonant x matra x sign, all
    2-consonant conjuncts, reph/rakar forms, common 3-consonant clusters) is
    shaped with the real font through MuPDF's HarfBuzz engine. Each glyph's
    text is solved by subtraction (word text minus known glyphs), with
    majority voting.
  * Self-test: every corpus word is decoded back through the runtime
    reordering logic and compared with the original text.

Usage:
  python3 build_glyph_db.py "/Library/Fonts/Arial Unicode.ttf" fonts/arial_unicode.json
Every JSON in fonts/ is loaded automatically at runtime. Add other fonts used
by government PDFs (Mangal, Nirmala UI, Kokila, Aparajita, Noto Sans
Devanagari...) the same way. The JSON only holds hashes, never font data.
"""
import os
import sys
import json
import tempfile
import unicodedata
from collections import Counter, defaultdict

import fitz
from fontTools.ttLib import TTFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glyph_hash import outline_hash  # noqa: E402

CONS = [chr(c) for c in range(0x0915, 0x093A)]
NUKTA_CONS = [chr(c) for c in range(0x0958, 0x0960)]
VOWELS = [chr(c) for c in range(0x0904, 0x0915)]
MATRAS = [chr(c) for c in range(0x093E, 0x094D)] + ['ॢ', 'ॣ']
SIGNS = ['ँ', 'ं', 'ः']
H = '्'
RA = 'र'
COMMON_TRIPLES = ['स्त्र', 'न्त्र', 'ष्ट्र', 'न्द्र', 'न्ध्र', 'स्थ्य', 'त्त्व', 'क्ष्म', 'ज्ज्व', 'त्स्न', 'न्त्य', 'ङ्क्ष',
                  'द्ध्र', 'ष्ट्य', 'क्त्र', 'च्छ्र', 'म्ब्र', 'ष्ण्य', 'ड्ड्र', 'क्ष्य', 'स्त्य', 'स्त्व', 'ह्म्य', 'र्त्य']


def is_deva(s):
    return any(0x0900 <= ord(c) <= 0x097F or 0xA8E0 <= ord(c) <= 0xA8FF for c in s)


def corpus():
    words = set()
    base = CONS + NUKTA_CONS
    # orphan marks: source typos render as dotted-circle + mark (◌ं, ◌े)
    for m in MATRAS + SIGNS + [H, '\u093C']:
        words.add(m)
    for v in VOWELS:
        words.add(v)
        for s in SIGNS:
            words.add(v + s)
    for c in base:
        words.add(c); words.add(c + H); words.add(c + '़')
        for m in MATRAS:
            words.add(c + m)
            for s in SIGNS[:2]:
                words.add(c + m + s)
        for s in SIGNS:
            words.add(c + s)
        # reph and rakar
        words.add(RA + H + c)
        words.add(c + H + RA)
        for m in ['ा', 'ि', 'ी', 'े', 'ै', 'ो', 'ु', 'ू']:
            words.add(RA + H + c + m)
            words.add(c + H + RA + m)
            words.add(RA + H + c + m + 'ं')
        words.add(RA + H + c + 'ं')
        words.add(c + H + RA + 'ं')
    for c1 in base:
        for c2 in CONS:
            cl = c1 + H + c2
            words.add(cl)
            for m in ['ा', 'ि', 'ी', 'े', 'ु', 'ू', 'ृ']:
                words.add(cl + m)
            words.add(cl + 'ं')
            words.add(cl + 'िं')
            words.add(RA + H + cl)
            words.add(cl + H + RA)
    for t in COMMON_TRIPLES:
        words.add(t)
        for m in ['ा', 'ि', 'ी', 'े', 'ु']:
            words.add(t + m)
        words.add(RA + H + t)
    for ch in '0123456789०१२३४५६७८९।॥॰ऽ.,:;-/()[]+&@%#*\'"?!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ':
        words.add(ch)
    return sorted(words)


def shape(font_path, words):
    """Shape words with the real font via MuPDF/HarfBuzz; return [(word, [gid...])]."""
    font_dir, font_file = os.path.split(os.path.abspath(font_path))
    css = ('@font-face {font-family: REF; src: url("%s");} '
           'body{font-family:REF;font-size:10pt;line-height:1.6}' % font_file)
    tmp = tempfile.NamedTemporaryFile(suffix='.pdf', delete=False).name
    # one word per line so lines can be split by baseline
    html = '<body>' + ''.join(f'<p>{w}</p>' for w in words) + '</body>'
    story = fitz.Story(html=html, user_css=css, archive=fitz.Archive(font_dir))
    writer = fitz.DocumentWriter(tmp)
    rect = fitz.paper_rect('a4')
    more = 1
    while more:
        dev = writer.begin_page(rect)
        more, _ = story.place(rect + (20, 20, -20, -20))
        story.draw(dev)
        writer.end_page()
    writer.close()
    doc = fitz.open(tmp)
    lines = []
    for page in doc:
        cur, cy = [], None
        for sp in page.get_texttrace():
            for (_uc, gid, origin, _bb) in sp['chars']:
                if cy is not None and abs(origin[1] - cy) > 6:
                    lines.append(cur); cur = []
                cur.append(gid); cy = origin[1]
        if cur:
            lines.append(cur)
    doc.close()
    os.unlink(tmp)
    if len(lines) != len(words):
        raise RuntimeError(f'line split mismatch: {len(lines)} lines vs {len(words)} words')
    return list(zip(words, lines))


def subtract(text, parts):
    rest = list(text)
    for p in parts:
        for ch in p:
            if ch in rest:
                rest.remove(ch)
            else:
                return None
    return ''.join(rest)


def gsub_walk(font, known):
    """gid -> text for every glyph reachable through single/ligature GSUB
    substitutions, starting from already-known glyphs. Feature-aware:
    'blwf'/'pstf' र+् is the below-base rakar (्र), 'rphf' is reph (र्)."""
    if 'GSUB' not in font:
        return {}
    name2gid = {n: i for i, n in enumerate(font.getGlyphOrder())}
    t = font['GSUB'].table
    feat_of = defaultdict(set)
    for fr in t.FeatureList.FeatureRecord:
        for li in fr.Feature.LookupListIndex:
            feat_of[li].add(fr.FeatureTag)
    txt = dict(known)
    lookups = t.LookupList.Lookup
    for _ in range(6):
        changed = False
        for li, lk in enumerate(lookups):
            feats = feat_of.get(li, set())
            for st in lk.SubTable:
                typ = lk.LookupType
                if typ == 7:
                    typ, st = st.ExtSubTable.LookupType, st.ExtSubTable
                if typ == 1:
                    for a, b in st.mapping.items():
                        ga, gb = name2gid.get(a), name2gid.get(b)
                        if ga in txt and gb not in txt:
                            txt[gb] = txt[ga]; changed = True
                elif typ == 4:
                    for first, ligs in st.ligatures.items():
                        for lig in ligs:
                            comps = [name2gid.get(first)] + [name2gid.get(c) for c in lig.Component]
                            gl = name2gid.get(lig.LigGlyph)
                            if gl in txt or not all(c in txt for c in comps):
                                continue
                            s = ''.join(txt[c] for c in comps).replace('\u094D\u094D', '\u094D')
                            if feats & {'blwf', 'pstf'} and s in ('र्', '्र'):
                                s = '्र'
                            txt[gl] = s; changed = True
        if not changed:
            break
    return {g: s for g, s in txt.items() if g not in known}


def build(font_path, verbose=True):
    font = TTFont(font_path, fontNumber=0)
    order = font.getGlyphOrder()
    name2gid = {n: i for i, n in enumerate(order)}
    known = {}
    for cp, g in font.getBestCmap().items():
        gid = name2gid[g]
        ch = chr(cp)
        if gid not in known or (is_deva(ch) and not is_deva(known[gid])):
            known[gid] = ch

    # the dotted circle is inserted by the shaper, never part of the data
    for gid, t in list(known.items()):
        if t == '\u25CC':
            known[gid] = ''
    words = corpus()
    shaped = shape(font_path, words)
    for _ in range(8):
        votes = defaultdict(Counter)
        for w, gids in shaped:
            unk = [g for g in gids if g not in known]
            if len(set(unk)) != 1:
                continue
            if len(unk) != 1:
                continue
            left = subtract(w, [known[g] for g in gids if g in known])
            if left:
                votes[unk[0]][left] += 1
        if not votes:
            break
        for g, c in votes.items():
            known[g] = c.most_common(1)[0][0]

    # Second layer: static GSUB walk for ligatures the corpus shaping never
    # produced (other PDF generators / Uniscribe pick different glyphs).
    gsub_extra = gsub_walk(font, dict(known))
    for gid, t in gsub_extra.items():
        if gid not in known:
            known[gid] = t

    # self-test with the runtime reordering
    from glyph_decoder import logical_order
    bad = []
    for w, gids in shaped:
        if any(g not in known for g in gids):
            bad.append((w, 'unknown glyph'))
            continue
        got = logical_order([known[g] for g in gids])
        if unicodedata.normalize('NFC', got) != unicodedata.normalize('NFC', w):
            bad.append((w, got))
    if verbose:
        print(f'corpus {len(shaped)} words, self-test failures: {len(bad)}')
        for w, got in bad[:40]:
            print('  ', w, '->', got)

    gs = font.getGlyphSet()
    db = {}
    for gid, s in known.items():
        if not (is_deva(s) or all(ord(c) < 0x2100 for c in s)):
            continue  # keep DB small: Devanagari + Latin/punct only
        try:
            h = outline_hash(gs, order[gid])
        except Exception:
            continue
        if h is None:
            continue
        if h in db and db[h] != s:
            # identical outline, different readings: keep the Devanagari / shortest
            if is_deva(db[h]) and not is_deva(s):
                continue
            if is_deva(db[h]) == is_deva(s) and len(db[h]) <= len(s):
                continue
        db[h] = s
    return db, bad, len(shaped)


if __name__ == '__main__':
    src, out = sys.argv[1], sys.argv[2]
    db, bad, n = build(src)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump({'source': os.path.basename(src), 'selftest': {'words': n, 'failures': len(bad)},
                   'glyphs': db}, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(db)} glyph outlines -> {out}')
