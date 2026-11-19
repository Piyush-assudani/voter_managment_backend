"""
Glyph-level text extraction for PDFs with broken Devanagari ToUnicode maps.

How it works
  1. For every embedded TrueType font in the PDF, hash each glyph outline.
  2. Look the hash up in the reference DB (fonts/*.json, built by
     build_glyph_db.py) -> exact Unicode for that glyph (incl. conjuncts).
  3. Re-order visual glyph order to logical Unicode order
     (pre-base ि, reph र्, etc.).
  4. Return positioned lines/words so a layout parser can read the cards.

Anything not in the DB falls back to the PDF's own ToUnicode char and is
reported in `stats['unknown']`, so the caller can decide to OCR that span.
"""
import io
import os
import re
import json
import glob
import unicodedata
from functools import lru_cache

import fitz
from fontTools.ttLib import TTFont

from glyph_hash import outline_hash

HERE = os.path.dirname(os.path.abspath(__file__))

VIRAMA = '्'
NUKTA = '़'
I_MATRA = 'ि'
REPH = 'र्'


@lru_cache(maxsize=1)
def load_db():
    db = {}
    for path in sorted(glob.glob(os.path.join(HERE, 'fonts', '*.json'))):
        with open(path, encoding='utf-8') as fh:
            for h, s in json.load(fh)['glyphs'].items():
                db.setdefault(h, s)
    return db


def _is_consonant(ch):
    return 'क' <= ch <= 'ह' or 'क़' <= ch <= 'य़' or ch in 'ॹॺॻॼॾॿ'


def _is_dep(ch):
    # matras, signs that follow a consonant in logical order
    return ('ऺ' <= ch <= 'ौ' and ch != I_MATRA) or ch in 'ँंःॎॏॕॖॗॢॣ'


def _parse_tounicode(doc, xref):
    out = {}
    tu = doc.xref_get_key(xref, 'ToUnicode')
    if tu[0] != 'xref':
        return out
    try:
        cmap = doc.xref_stream(int(tu[1].split()[0])).decode('latin-1')
    except Exception:
        return out
    def u(h):
        h = h.strip('<>')
        try:
            return bytes.fromhex(h).decode('utf-16-be', 'ignore')
        except Exception:
            return ''
    for blk in re.findall(r'beginbfchar(.*?)endbfchar', cmap, re.S):
        for a, b in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>', blk):
            out[int(a, 16)] = u(b)
    for blk in re.findall(r'beginbfrange(.*?)endbfrange', cmap, re.S):
        for a, b, c in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', blk):
            a, b = int(a, 16), int(b, 16)
            base = u(c)
            for k in range(a, b + 1):
                out[k] = base[:-1] + chr(ord(base[-1]) + k - a) if base else ''
    return out


class FontMap:
    """gid -> unicode for one embedded font."""

    def __init__(self, doc, xref):
        self.gid_text = {}
        self.ok = False
        try:
            desc = doc.xref_get_key(xref, 'FontDescriptor')
            if desc[0] != 'xref':
                # Type0: descend to the CIDFont
                desc_f = doc.xref_get_key(xref, 'DescendantFonts')
                m = re.search(r'(\d+) 0 R', desc_f[1])
                if not m:
                    return
                desc = doc.xref_get_key(int(m.group(1)), 'FontDescriptor')
            dx = int(desc[1].split()[0])
            for key in ('FontFile2', 'FontFile3', 'FontFile'):
                ff = doc.xref_get_key(dx, key)
                if ff[0] == 'xref':
                    data = doc.xref_stream(int(ff[1].split()[0]))
                    break
            else:
                return
            font = TTFont(io.BytesIO(data))
            gs = font.getGlyphSet()
            self.order = font.getGlyphOrder()
            # gid -> ToUnicode value (used to pick the right subset for a span)
            self.gid_uc = {}
            code2uc = _parse_tounicode(doc, xref)
            cm = {}
            for t in font['cmap'].tables:
                cm.update(t.cmap)
            name2gid = {n: i for i, n in enumerate(self.order)}
            for code, uc in code2uc.items():
                g = cm.get(code, cm.get(0xF000 + code))
                if g in name2gid:
                    self.gid_uc[name2gid[g]] = uc
            db = load_db()
            for gid, name in enumerate(font.getGlyphOrder()):
                try:
                    h = outline_hash(gs, name)
                except Exception:
                    continue
                if h is None:
                    self.gid_text[gid] = ''  # empty outline (space)
                elif h in db:
                    self.gid_text[gid] = db[h]
            self.ok = True
        except Exception:
            self.ok = False


def logical_order(glyph_texts):
    """glyph_texts: list of per-glyph strings in visual order -> logical string."""
    seq = list(glyph_texts)
    out = []
    i = 0
    n = len(seq)
    # pass 1: pre-base i-matra -> after the following cluster
    while i < n:
        g = seq[i]
        if g and g.startswith(I_MATRA) and i + 1 < n:
            # collect the cluster that follows: half-forms (ending in virama) + base (+nukta)
            j = i + 1
            cluster = []
            while j < n and seq[j] and seq[j].endswith(VIRAMA) and seq[j] != REPH:
                cluster.append(seq[j]); j += 1
            if j < n and seq[j] and _is_consonant(seq[j][0]):
                cluster.append(seq[j]); j += 1
                while j < n and seq[j] and (seq[j][0] in (NUKTA,) or seq[j].startswith('्र')):
                    cluster.append(seq[j]); j += 1
                out.extend(cluster)
                out.append(g)
                i = j
                continue
        out.append(g)
        i += 1
    # pass 2: reph (visually after its syllable) -> before the syllable's base cluster
    res = []
    pending_tail = ''
    for idx, g in enumerate(out):
        is_reph = g == REPH or (g and g.startswith(REPH) and len(g) > 2 and not _is_consonant(g[2]))
        if pending_tail and not (g and (_is_consonant(g[0]) or g.endswith(VIRAMA) or all(_is_dep(c) or c in (NUKTA, I_MATRA) for c in g) or g.startswith('्र'))):
            res.append(pending_tail); pending_tail = ''
        if is_reph and len(g) > 2 and idx + 1 < len(out) and out[idx + 1] and _is_consonant(out[idx + 1][0]):
            # reph+sign ligature drawn before its base (HarfBuzz/Uniscribe order):
            # reph is already logical; the sign goes after the whole syllable
            res.append(REPH)
            pending_tail = g[2:]
            continue
        if is_reph:
            tail = g[2:]  # e.g. reph+anusvara ligature
            k = len(res)
            # skip dependent signs / i-matra
            while k > 0 and res[k - 1] and (all(_is_dep(c) or c == I_MATRA for c in res[k - 1])):
                k -= 1
            # skip base consonant (+nukta) cluster
            if k > 0 and res[k - 1] and _is_consonant(res[k - 1][0]):
                k -= 1
                while k > 0 and res[k - 1] and res[k - 1].endswith(VIRAMA):
                    k -= 1
            res.insert(k, REPH)
            if tail:
                res.append(tail)
        else:
            res.append(g)
    if pending_tail:
        res.append(pending_tail)
    s = ''.join(res).replace(VIRAMA + VIRAMA, VIRAMA)
    # ensure matra/sign order is canonical (nukta before matra etc.)
    s = unicodedata.normalize('NFC', s)
    return s


class GlyphPDF:
    def __init__(self, path_or_doc):
        self.doc = path_or_doc if isinstance(path_or_doc, fitz.Document) else fitz.open(path_or_doc)
        self.fonts = {}
        self.stats = {'glyphs': 0, 'unknown': 0, 'unknown_at': []}

    def page_chars(self, page):
        """Yield dicts: text, x0, x1, y (baseline), size, font."""
        # map texttrace font names to xref: texttrace gives the basefont w/o subset tag
        xref_by_name = {}
        for f in page.get_fonts(full=True):
            xref_by_name.setdefault(f[3].split('+')[-1], []).append(f[0])
        cache = {}
        items = []
        seen = set()
        for span in page.get_texttrace():
            fname = span['font']
            # several subsets can share a base name: disambiguate via the glyph DB hit rate
            cands = xref_by_name.get(fname, [])
            best, best_score = None, -1
            for xr in cands:
                if xr not in cache:
                    cache[xr] = FontMap(self.doc, xr)
                fm = cache[xr]
                if not fm.ok:
                    continue
                score = sum(1 for (uc, gid, _o, _b) in span['chars']
                            if gid in fm.gid_uc and fm.gid_uc[gid][:1] == chr(uc))
                if score > best_score:
                    best, best_score = fm, score
            for (uc, gid, origin, bbox) in span['chars']:
                key = (gid, round(origin[0], 1), round(origin[1], 1))
                if key in seen:
                    continue  # glyph painted twice (fill + stroke / fake bold)
                seen.add(key)
                self.stats['glyphs'] += 1
                t = best.gid_text.get(gid) if best and best.ok else None
                if t is None:
                    t = chr(uc) if uc > 0 else ''
                    if not t.isascii():
                        self.stats['unknown'] += 1
                        if len(self.stats['unknown_at']) < 50:
                            self.stats['unknown_at'].append({'page': page.number + 1, 'x': round(bbox[0]), 'y': round(origin[1]), 'fallback': t})
                elif t == '' and uc == 32:
                    t = ' '
                items.append({'t': t, 'x0': bbox[0], 'x1': bbox[2], 'y': origin[1],
                              'top': bbox[1], 'bottom': bbox[3], 'size': span['size'], 'seq': span['seqno']})
        return items

    def page_words(self, page, gap_ratio=0.3):
        """Group glyphs into words (logical Unicode) with bboxes.

        Glyphs are kept in content-stream order (the shaper's order) inside a
        word; sorting by x would scramble zero-width marks like े.
        """
        chars = self.page_chars(page)
        words, cur, right = [], [], None
        for c in chars:
            if c['t'] in (' ', ''):
                if c['t'] == ' ' and cur:
                    words.append(cur); cur = []
                continue
            if cur:
                same_line = abs(c['y'] - cur[-1]['y']) < 1.5
                gap = c['x0'] - right
                if not same_line or gap > c['size'] * gap_ratio or gap < -c['size'] * 1.5:
                    words.append(cur); cur = []
            if not cur:
                right = c['x1']
            cur.append(c)
            right = max(right, c['x1'])
        if cur:
            words.append(cur)
        out = []
        for w in words:
            text = logical_order([c['t'] for c in w])
            out.append({'text': text, 'x0': min(c['x0'] for c in w), 'x1': max(c['x1'] for c in w),
                        'y': w[0]['y'], 'top': min(c['top'] for c in w), 'bottom': max(c['bottom'] for c in w)})
        return out


if __name__ == '__main__':
    import sys
    g = GlyphPDF(sys.argv[1])
    pno = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    page = g.doc[pno]
    ws = g.page_words(page)
    ws.sort(key=lambda w: (round(w['y']), w['x0']))
    line, ly = [], None
    for w in ws:
        if ly is not None and abs(w['y'] - ly) > 1.5:
            print(' '.join(line)); line = []
        line.append(w['text']); ly = w['y']
    print(' '.join(line))
    print(g.stats, file=sys.stderr)
