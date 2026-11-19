#!/usr/bin/env python3
"""
VijaySetu glyph-exact electoral roll extractor (Engine 0).

Reads SEC / ECI electoral roll PDFs whose Devanagari text layer is broken,
by decoding the embedded font glyphs (see glyph_decoder.py), then parses the
voter cards by layout. No OCR is involved for text-layer PDFs, so the output
is exactly what is printed.

Handles:
  * main roll (मूल नामावली) + supplements (पूरक-1, पूरक-2 ...):
    घटक 1 परिवर्धन (additions), घटक 2 विलोपन (deletions), घटक 3 संशोधन (corrections)
  * E / S / R deletion markers on cards (Death / Shifted / Repetition)
  * section / locality headings (e.g. "जाटों की ढाणी")
  * photo extraction (WithPhoto PDFs)
  * self-verification against the counts printed in the PDF itself

CLI (same contract as scripts/extract_voters_perfect.py):
  roll_extractor.py --pdf in.pdf --output out.xlsx [--ward N] [--booth N]
                    [--extract-photos-dir DIR] [--include-deleted] [--json out.json]
Prints one JSON line at the end: {"success":..,"count":..,"verification":{..}}
Exit codes: 3 = no text layer (scanned PDF), 4 = no voter cards recognised,
            5 = embedded font not in the glyph DB. All mean "use the next engine".
"""
import os
import re
import sys
import json
import argparse
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import fitz  # noqa: E402
from glyph_decoder import GlyphPDF  # noqa: E402

EPIC_RE = re.compile(r'^(?:[A-Z]{2,3}\d{6,8}|[A-Z]{2}/\d{1,3}/\d{1,4}/\d{3,8})$')
DEL_REASON = {'E': 'मृत्यु (Death)', 'S': 'स्थानांतरित (Shifted)', 'R': 'दोहराव (Repetition)'}
REL_WORDS = {'पिता': 'पिता', 'पति': 'पति', 'माता': 'माता', 'अन्य': 'अन्य', 'संरक्षक': 'संरक्षक'}
PHOTO_WORDS = {'Photo', 'is', 'Available', 'Not'}
GENDER_MAP = {'पुरूष': 'पुरुष', 'पुरुष': 'पुरुष', 'स्त्री': 'स्त्री', 'महिला': 'स्त्री', 'तृतीय': 'तृतीय लिंग', 'अन्य': 'तृतीय लिंग'}


# ---------------------------------------------------------------- helpers
def lines_of(words, tol=3.0):
    ws = sorted(words, key=lambda w: (w['y'], w['x0']))
    out = []
    for w in ws:
        if out and abs(out[-1][0]['y'] - w['y']) < tol:
            out[-1].append(w)
        else:
            out.append([w])
    for ln in out:
        ln.sort(key=lambda w: w['x0'])
    return out


def line_text(ln):
    return ' '.join(w['text'] for w in ln)


def right_of(words, label, tol=4.5, stop_x=None):
    """Words on the label's line, to its right."""
    res = [w for w in words if abs(w['y'] - label['y']) < tol and (w['x0'] + w['x1']) / 2 > label['x1'] and w is not label]
    if stop_x is not None:
        res = [w for w in res if w['x0'] < stop_x]
    return sorted(res, key=lambda w: w['x0'])


def clean_value(ws):
    return ' '.join(w['text'] for w in ws if w['text'] not in PHOTO_WORDS).strip(' :')


# ---------------------------------------------------------------- page model
class Page:
    def __init__(self, gpdf, page):
        self.page = page
        self.words = self._merge_spaced_colons(gpdf.page_words(page))
        # split "नाम:value" glued words into label + value
        fixed = []
        for w in self.words:
            m = re.match(r'^(नाम:|संख्या:|आयु:|लिंग:)(.+)$', w['text'])
            if m:
                lab, val = m.group(1), m.group(2)
                frac = len(lab) / len(w['text'])
                cut = w['x0'] + (w['x1'] - w['x0']) * frac
                fixed.append({**w, 'text': lab, 'x1': cut})
                fixed.append({**w, 'text': val, 'x0': cut})
            else:
                fixed.append(w)
        self.words = fixed
        self.text = ' '.join(w['text'] for w in sorted(self.words, key=lambda w: (round(w['y']), w['x0'])))

    @staticmethod
    def _merge_spaced_colons(words):
        """'नाम :' / 'उम्र :' (ECI style) -> 'नाम:' so one parser handles both layouts."""
        out = []
        for w in words:
            if w['text'] in (':', 'ः') and out and abs(out[-1]['y'] - w['y']) < 3 and w['x0'] - out[-1]['x1'] < 6:
                out[-1] = {**out[-1], 'text': out[-1]['text'] + ':', 'x1': w['x1']}
                continue
            t = w['text']
            if t in ('उम्र:', 'आयु:'):
                t = 'आयु:'
            out.append({**w, 'text': t})
        return out

    def name_anchors(self):
        anchors = []
        by_line = lines_of(self.words)
        for ln in by_line:
            for i, w in enumerate(ln):
                if w['text'] == 'नाम:' and not (i > 0 and ln[i - 1]['text'] == 'का' and w['x0'] - ln[i - 1]['x1'] < 8):
                    anchors.append(w)
        # a real card has an आयु: label just below its name label, same column
        ages = [w for w in self.words if w['text'] == 'आयु:']
        return [a for a in anchors
                if any(abs(g['x0'] - a['x0']) < 12 and 15 < g['y'] - a['y'] < 70 for g in ages)]


def parse_card(words, anchor, colw):
    """words: all words inside this card's box."""
    top = [w for w in words if w['y'] < anchor['y'] - 6]
    card = {'serial': None, 'epic': '', 'marker': '', 'name': '', 'relation': '', 'relative': '',
            'house': '', 'age': None, 'gender': ''}
    # --- top row: [marker] serial  EPIC
    for w in sorted(top, key=lambda w: w['x0']):
        t = w['text']
        if re.fullmatch(r'[ESR]', t) and not card['serial']:
            card['marker'] = t
        elif re.fullmatch(r'\d{1,5}', t) and card['serial'] is None:
            card['serial'] = int(t)
        elif EPIC_RE.match(t):
            card['epic'] = t
        elif re.fullmatch(r'[A-Z0-9/]{6,}', t) and not card['epic']:
            card['epic'] = t
    # --- name (may wrap to the next line(s) until the relation line)
    rel_label = None
    for w in words:
        if w['text'] == 'नाम:' and w is not anchor:
            prev = [p for p in words if abs(p['y'] - w['y']) < 3 and p['x1'] <= w['x0'] + 1 and w['x0'] - p['x1'] < 8 and p['text'] == 'का']
            if prev:
                rel_label = w
                break
    photo_x = anchor['x0'] + colw * 0.62
    name_ws = right_of(words, anchor, tol=3, stop_x=photo_x)
    if rel_label is not None:
        for w in words:
            if anchor['y'] + 3 < w['y'] < rel_label['y'] - 3 and w['x0'] < photo_x and w['text'] not in PHOTO_WORDS:
                name_ws.append(w)
    card['name'] = clean_value(name_ws)
    # --- relation
    if rel_label is not None:
        same = sorted([w for w in words if abs(w['y'] - rel_label['y']) < 3 and w['x1'] <= rel_label['x0'] + 1], key=lambda w: w['x0'])
        rtype = ''
        for w in same:
            if w['text'] in REL_WORDS:
                rtype = REL_WORDS[w['text']]
        card['relation'] = rtype
        card['relative'] = clean_value(right_of(words, rel_label, tol=3, stop_x=photo_x + 30))
    # --- house / age / gender
    for w in words:
        if w['text'] == 'संख्या:' and any(p['text'] == 'मकान' and abs(p['y'] - w['y']) < 3 for p in words):
            card['house'] = clean_value(right_of(words, w, tol=5, stop_x=anchor['x0'] + colw - 8))
        elif w['text'] == 'आयु:':
            vals = [v for v in right_of(words, w, tol=5) if re.fullmatch(r'\d{1,3}', v['text'])]
            if vals:
                card['age'] = int(vals[0]['text'])
        elif w['text'] == 'लिंग:':
            vals = [v for v in right_of(words, w, tol=5) if v['text'] not in PHOTO_WORDS]
            if vals:
                card['gender'] = GENDER_MAP.get(vals[0]['text'], vals[0]['text'])
    card['bbox'] = (anchor['x0'] - 8, anchor['y'] - 30, anchor['x0'] - 8 + colw, anchor['y'] + 52)
    return card


def page_cards(pg):
    anchors = pg.name_anchors()
    if not anchors:
        return [], []
    xs = sorted(set(round(a['x0']) for a in anchors))
    diffs = [b - a for a, b in zip(xs, xs[1:]) if b - a > 60]
    colw = min(diffs) if diffs else 173.5
    cards = []
    used = set()
    for a in anchors:
        x0, x1 = a['x0'] - 8, a['x0'] - 8 + colw
        # bottom: next anchor in the same column
        below = [b['y'] for b in anchors if abs(b['x0'] - a['x0']) < 20 and b['y'] > a['y'] + 10]
        y1 = min(below) - 26 if below else a['y'] + 52
        y1 = min(y1, a['y'] + 60)
        ws = [w for w in pg.words if x0 <= (w['x0'] + w['x1']) / 2 < x1 and a['y'] - 28 <= w['y'] <= y1]
        for w in ws:
            used.add(id(w))
        c = parse_card(ws, a, colw)
        c['_y'] = a['y']
        c['_x'] = a['x0']
        cards.append(c)
    leftovers = [w for w in pg.words if id(w) not in used]
    return cards, leftovers


# ---------------------------------------------------------------- document
BOILER = ('राज्य निर्वाचन', 'पंचायत चुनाव', 'नगरपालिका', 'जिलापरिषद', 'पंचायत समिति', 'ग्रामपंचायत', 'वार्ड क्रमांक',
          'विधानसभा', 'जि॰', 'पं॰', 'पृष्ठ संख्या', 'आयु 1 जनवरी', 'निर्वाचन पंजीकरण', 'Deleted', 'पूरक', 'पुनरीक्षण',
          'घटक', 'की संख्या', 'पुरुष', 'स्त्री', 'तृतीय', 'कुल', 'संख्या', 'मूल नामावली')


def parse_cover(pg):
    t = pg.text
    info = {}

    def grab(pattern):
        m = re.search(pattern, t)
        return m.group(1).strip() if m else ''
    info['district'] = grab(r'जिलापरिषद का नाम\s*:\s*(\S+)')
    info['panchayat_samiti'] = grab(r'पंचायत समिति का नाम\s*:\s*(\S+)')
    info['gram_panchayat'] = grab(r'ग्रामपंचायत\s*:\s*(\S+(?:\s\S+)?)\s+(?:वार्ड|जि॰|पं॰|$)') or grab(r'ग्रामपंचायत\s*:\s*(\S+)')
    info['ward'] = grab(r'वार्ड क्रमांक\s*:\s*(\d+)')
    info['assembly'] = grab(r'विधानसभा क्षेत्र की संख्या एवं नाम\s*:?-?\s*([\d]+\s*-\s*\S+)')
    info['main_village'] = grab(r'मुख्य गांव\s*:\s*(\S+)')
    info['tehsil'] = grab(r'तहसील\s*:\s*(\S+)')
    info['booth'] = grab(r'मतदान बूथ की संख्या एवं पता\s*:\s*(\d+)')
    info['booth_address'] = grab(r'मतदान बूथ की संख्या एवं पता\s*:\s*\d+\s*-\s*(.+?)\s+मतदाताओं')
    m = re.search(r'क्रम संख्या क्रम संख्या\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)', t)
    if m:
        a = list(map(int, m.groups()))
        info['cover_counts'] = {'first_serial': a[0], 'last_serial': a[1], 'male': a[2], 'female': a[3], 'third': a[4], 'total': a[5]}
    return info


def section_tables(pg):
    """Counts printed under each supplement section: (kind, male, female, third, total)."""
    out = []
    for kind, word in (('add', 'परिवर्धन'), ('del', 'विलोपन'), ('corr', 'संशोधन')):
        for m in re.finditer(word + r'\s+की\s+(?:पुरुष|पुरूष)\s+स्त्री\s+तृतीय\s+लिंग\s+कुल\s+संख्या\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)', pg.text):
            out.append((kind,) + tuple(map(int, m.groups())))
    return out


def extract(pdf_path, include_deleted=False, photos_dir=None, ward=None, booth=None):
    gpdf = GlyphPDF(pdf_path)
    doc = gpdf.doc
    info = {}
    voters = {}      # serial -> record (main + additions)
    deletions = {}   # serial -> marker
    corrections = []
    printed_counts = []
    section = 'main'
    locality = ''
    supplement = ''
    photo_items = []
    order = 0

    for pno in range(len(doc)):
        pg = Page(gpdf, doc[pno])
        if pno == 0 or not info.get('ward'):
            ci = parse_cover(pg)
            for k, v in ci.items():
                if v and not info.get(k):
                    info[k] = v
        printed_counts.extend(section_tables(pg))
        cards, leftovers = page_cards(pg)

        # section switches and locality headings, in vertical order with cards
        events = []
        for ln in lines_of(leftovers):
            txt = line_text(ln)
            y = ln[0]['y']
            if 'घटक' in txt and 'परिवर्धन' in txt:
                events.append((y, 'section', 'add'))
            elif 'घटक' in txt and 'विलोपन' in txt:
                events.append((y, 'section', 'del'))
            elif 'घटक' in txt and 'संशोधन' in txt:
                events.append((y, 'section', 'corr'))
            elif re.search(r'पूरक संख्या\s*-\s*\d+', txt):
                supplement = 'पूरक-' + re.search(r'पूरक संख्या\s*-\s*(\d+)', txt).group(1)
            elif y > 140 and not any(b in txt for b in BOILER) and not re.fullmatch(r'[\d\s]+', txt) \
                    and not txt.startswith('मतदाताओं') and len(txt) > 2 and 'Photo' not in txt:
                # heading only if a card row starts right below it
                if any(0 < (c['_y'] - 28) - y < 40 for c in cards):
                    events.append((y, 'locality', txt.strip(' ,')))
        events.sort()

        def state_at(y):
            nonlocal section, locality
            s, l = section, locality
            for ey, kind, val in events:
                if ey < y:
                    if kind == 'section':
                        s = val
                    else:
                        l = val
            return s, l

        # cards in reading order (row by row, left to right)
        cards.sort(key=lambda c: (round(c['_y'] / 10), c['_x']))
        page_images = []
        if photos_dir:
            for im in doc[pno].get_images(full=True):
                for r in doc[pno].get_image_rects(im[0]):
                    # voter photos are portrait; the DELETED stamp overlay is landscape
                    if 25 < r.width < 120 and 30 < r.height < 120 and r.height > r.width * 1.1:
                        page_images.append((im[0], r))
        for c in cards:
            sec, loc = state_at(c['_y'])
            c['section'] = sec
            c['locality'] = loc
            c['page'] = pno + 1
            c['supplement'] = supplement if sec != 'main' else 'मूल नामावली'
            if photos_dir:
                bx = fitz.Rect(c['bbox'])
                for xref, r in page_images:
                    if bx.contains(fitz.Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)):
                        c['_photo'] = (xref, r)
                        break
        # apply section end state for next page
        for ey, kind, val in events:
            if kind == 'section':
                section = val
            else:
                locality = val

        for c in cards:
            if c['serial'] is None:
                continue
            order += 1
            c['_order'] = order
            sec = c['section']
            if sec == 'del':
                deletions[c['serial']] = c['marker'] or 'D'
            elif sec == 'corr':
                corrections.append(c)
            else:
                if sec == 'add':
                    c['status_note'] = 'परिवर्धन (' + c['supplement'] + ')'
                prev = voters.get(c['serial'])
                if prev is None or sec == 'add':
                    voters[c['serial']] = c
            if photos_dir and c.get('_photo') and sec in ('main', 'add'):
                photo_items.append(c)

    # apply corrections (replace details, keep serial)
    for c in corrections:
        if c['serial'] in voters:
            base = voters[c['serial']]
            for k in ('name', 'relation', 'relative', 'house', 'age', 'gender', 'epic'):
                if c.get(k):
                    base[k] = c[k]
            base['status_note'] = 'संशोधित (' + c['supplement'] + ')'
    # deletions
    for s, mk in deletions.items():
        if s in voters:
            voters[s]['marker'] = voters[s]['marker'] or mk
    rows = []
    for s in sorted(voters):
        v = voters[s]
        deleted = bool(v['marker'])
        v['status'] = 'Deleted' if deleted else 'Active'
        if deleted:
            v['status_note'] = ('विलोपित - ' + DEL_REASON.get(v['marker'], v['marker']) + ' ' + v.get('status_note', '')).strip()
        v['deleted'] = deleted
        if deleted and not include_deleted:
            continue
        rows.append(v)

    if ward:
        info['ward'] = str(ward)
    if booth:
        info['booth'] = str(booth)

    # photos
    manifest = []
    if photos_dir:
        os.makedirs(photos_dir, exist_ok=True)
        for c in photo_items:
            xref, r = c['_photo']
            try:
                img = doc.extract_image(xref)
                ext = img.get('ext', 'jpg')
                fn = f"{c['serial']}_{re.sub(r'[^A-Za-z0-9]', '_', c['epic'] or 'noepic')}.{ext}"
                with open(os.path.join(photos_dir, fn), 'wb') as fh:
                    fh.write(img['image'])
                manifest.append({'serial': c['serial'], 'epic': c['epic'], 'photo_file': fn})
            except Exception:
                pass
        with open(os.path.join(photos_dir, 'photos_manifest.json'), 'w', encoding='utf-8') as fh:
            json.dump(manifest, fh, ensure_ascii=False)

    verification = verify(voters, deletions, printed_counts, info, gpdf.stats)
    return rows, info, verification, len(manifest)


def verify(voters, deletions, printed_counts, info, stats):
    """Cross-check the extraction against the numbers printed inside the PDF."""
    v = {'glyphs': stats['glyphs'], 'undecoded_glyphs': stats['unknown'], 'undecoded_at': stats.get('unknown_at', []),
         'checks': [], 'ok': True}

    def check(name, expected, got):
        ok = expected == got
        v['checks'].append({'check': name, 'expected': expected, 'got': got, 'ok': ok})
        if not ok:
            v['ok'] = False

    all_v = list(voters.values())
    active = [x for x in all_v if not x['marker']]
    serials = sorted(voters)
    if serials:
        missing = sorted(set(range(serials[0], serials[-1] + 1)) - set(serials))
        check('serials contiguous (missing list)', [], missing)
    adds = [x for x in all_v if x.get('section') == 'add']
    printed_add = [c for c in printed_counts if c[0] == 'add']
    printed_del = [c for c in printed_counts if c[0] == 'del']
    if printed_add:
        check('additions total (printed)', sum(c[4] for c in printed_add), len(adds))
        check('additions male (printed)', sum(c[1] for c in printed_add), sum(1 for x in adds if x['gender'] == 'पुरुष'))
    if printed_del:
        check('deletions total (printed)', sum(c[4] for c in printed_del), len(deletions))
    cc = info.get('cover_counts')
    if cc:
        check('last serial (cover)', cc['last_serial'], serials[-1] if serials else None)
        check('active voters = cover total', cc['total'], len(active))
        check('active male = cover', cc['male'], sum(1 for x in active if x['gender'] == 'पुरुष'))
        check('active female = cover', cc['female'], sum(1 for x in active if x['gender'] == 'स्त्री'))
    # field completeness
    for fld in ('name', 'relative', 'age', 'gender', 'epic'):
        empty = [x['serial'] for x in active if not x.get(fld)]
        if fld == 'epic':
            v['cards_without_epic'] = empty  # legitimately blank on some new additions
            continue
        check(f'all active cards have {fld}', [], empty)
    bad_age = [x['serial'] for x in active if x.get('age') is not None and not (18 <= x['age'] <= 125)]
    check('ages within 18-125', [], bad_age)
    v['active'] = len(active)
    v['deleted'] = len(all_v) - len(active)
    v['gender_split'] = dict(Counter(x['gender'] for x in active))
    return v


# ---------------------------------------------------------------- excel
HI_HEADERS = ['क्रमांक', 'पहचान पत्र क्रमांक (EPIC No)', 'मतदाता का नाम', 'संबंधी का नाम', 'संबंध प्रकार',
              'मकान संख्या', 'आयु', 'लिंग', 'गाँव / मोहल्ला', 'वार्ड संख्या', 'बूथ / भाग संख्या', 'स्थिति',
              'टिप्पणी', 'पृष्ठ']


def write_excel(rows, info, out_path):
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'मतदाता सूची'
    ws.append(HI_HEADERS)
    for cell in ws[1]:
        cell.font = Font(bold=True, color='FFFFFF')
        cell.fill = PatternFill('solid', start_color='1A365D')
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    for r in rows:
        ws.append([r['serial'], r['epic'], r['name'], r['relative'], r['relation'], r['house'], r['age'],
                   r['gender'], r.get('locality') or info.get('main_village', ''), info.get('ward', ''),
                   info.get('booth', ''), r['status'], r.get('status_note', ''), r.get('page')])
    widths = [8, 20, 24, 24, 10, 12, 6, 8, 28, 8, 10, 26, 22, 6]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = w
    ws.freeze_panes = 'A2'
    meta = wb.create_sheet('विवरण')
    for k, v in info.items():
        meta.append([k, json.dumps(v, ensure_ascii=False) if isinstance(v, dict) else v])
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    wb.save(out_path)


def has_text_layer(pdf_path):
    d = fitz.open(pdf_path)
    n = sum(len(d[i].get_text('text').strip()) for i in range(min(4, len(d))))
    return n > 200


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pdf', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--ward', default='')
    ap.add_argument('--booth', '--part', dest='booth', default='')
    ap.add_argument('--extract-photos-dir', default=None)
    ap.add_argument('--include-deleted', action='store_true')
    ap.add_argument('--json', default=None, help='also dump records as JSON')
    a = ap.parse_args()
    if not has_text_layer(a.pdf):
        print(json.dumps({'success': False, 'count': 0, 'reason': 'no_text_layer'}))
        sys.exit(3)
    rows, info, ver, nphotos = extract(a.pdf, a.include_deleted, a.extract_photos_dir, a.ward, a.booth)
    # Font not in the glyph DB (e.g. a new department's PDF in Mangal/Nirmala):
    # refuse rather than emit text from the broken ToUnicode layer.
    if ver['glyphs'] and ver['undecoded_glyphs'] / ver['glyphs'] > 0.002:
        print(json.dumps({'success': False, 'count': 0, 'reason': 'unknown_font',
                          'undecoded_glyphs': ver['undecoded_glyphs'], 'glyphs': ver['glyphs'],
                          'hint': 'build a glyph DB for this font: python3 build_glyph_db.py <font.ttf> fonts/<name>.json'},
                         ensure_ascii=False))
        sys.exit(5)
    if not rows:
        print(json.dumps({'success': False, 'count': 0, 'reason': 'no_cards_found', 'verification': ver}, ensure_ascii=False))
        sys.exit(4)
    write_excel(rows, info, a.output)
    if a.json:
        with open(a.json, 'w', encoding='utf-8') as fh:
            json.dump({'info': info, 'verification': ver,
                       'voters': [{k: v for k, v in r.items() if not k.startswith('_') and k != 'bbox'} for r in rows]},
                      fh, ensure_ascii=False, indent=1)
    print(json.dumps({'success': True, 'count': len(rows), 'file': a.output, 'engine': 'glyph_exact',
                      'photos': nphotos, 'verified': ver['ok'], 'verification': ver}, ensure_ascii=False))


if __name__ == '__main__':
    main()
