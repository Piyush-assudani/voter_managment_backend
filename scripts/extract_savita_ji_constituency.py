#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VijaySetu Master Electoral Roll Compiler for सविता सतबीर कसाना:
Constituency: Deeg (डीग) / Nagar (नगर), Rajasthan
Covers 8 Gram Panchayats (70 Wards in total):
  1. भयाडी करमूका (BHAYADI KARMUKA) - 7 Wards
  2. चूल्हेरा (CHULHERA) - 9 Wards
  3. गढ़ी मेवात (GARHI MEWAT) - 7 Wards
  4. गुहाना (GUHANA) - 11 Wards
  5. जटेरी (JATERI) - 9 Wards
  6. खोह (KHOH) - 9 Wards
  7. निगोही (NIGOHI) - 7 Wards
  8. पसोपा (PASOPA) - 11 Wards

Features:
- Pure card extraction: Serials 1 to N, zero reliance on cover pages.
- Advanced Deeg-specific font phonetic normalization (सिंल -> सिंह, सालब -> साहब, राजेन्द्र, विश्वेन्द्र, etc.)
- Multi-sheet publication-grade Excel output with Dashboard & Summary sheet.
- Full JSON export for high-speed MongoDB database ingestion.
"""

import os
import sys
import glob
import re
import json
import time
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from scripts.extract_voters_perfect import (
    extract_single_pdf, transliterate_hindi, predict_rajasthan_caste, GLYPH_HASH_TO_HINDI
)

# Enforce accurate glyphs
GLYPH_HASH_TO_HINDI['eed4acd0cd'] = 'ह'
GLYPH_HASH_TO_HINDI['1861fa3ec0'] = 'न्द्र'

SAVITA_FOLDER = "/Users/piyush/Documents/Moxrathore_projects/vijaysetu/savita ji "
OUTPUT_EXCEL = "/Users/piyush/Documents/Moxrathore_projects/vijaysetu/Master_Voters_Savita_Satbir_Kasana.xlsx"
COPY_OUTPUT = os.path.join(SAVITA_FOLDER, "Master_Combined_Voters.xlsx")
JSON_OUTPUT = os.path.join(BACKEND_DIR, "data", "savita_ji_all_voters.json")

PANCHAYAT_MAP = {
    'BHAYADI KARMUKA': 'भयाडी करमूका',
    'CHULHERA': 'चूल्हेरा',
    'GARHI MEWAT': 'गढ़ी मेवात',
    'GUHANA': 'गुहाना',
    'JATERI': 'जटेरी',
    'KHOH': 'खोह',
    'NIGOHI': 'निगोही',
    'PASOPA': 'पसोपा'
}

HEADERS = [
    'क्रमांक', 'पहचान पत्र क्रमांक (EPIC No)', 'ग्राम पंचायत', 'वार्ड संख्या',
    'बूथ / भाग संख्या', 'वार्ड में क्र.', 'मतदाता का नाम (हिंदी)', 'मतदाता का नाम (English)',
    'संबंध प्रकार', 'संबंधी का नाम (हिंदी)', 'संबंधी का नाम (English)',
    'मकान संख्या', 'आयु', 'लिंग', 'जाति', 'मोबाइल नंबर', 'गाँव / मोहल्ला', 'स्थिति'
]

def clean_deeg_text(text):
    if not text or not isinstance(text, str):
        return text
    s = text.strip()
    
    # 1. Singh / Sahib fixes
    s = re.sub(r'(\b\w+)सिंल\b', r'\1 सिंह', s)
    s = re.sub(r'\bसिंल\b', 'सिंह', s)
    s = re.sub(r'\bसालब\b', 'साहब', s)
    s = re.sub(r'\bसामल\b', 'साहब', s)
    
    # 2. Deeg colloquial -endra fixes
    s = re.sub(r'\bविश्वेन्न\b', 'विश्वेन्द्र', s)
    s = re.sub(r'\bराजेंन\b', 'राजेन्द्र', s)
    s = re.sub(r'\bगजेन्न\b', 'गजेन्द्र', s)
    s = re.sub(r'\bगजेंन\b', 'गजेन्द्र', s)
    s = re.sub(r'\bपुष्पेंन\b', 'पुष्पेन्द्र', s)
    s = re.sub(r'\bविजेंन\b', 'विजेन्द्र', s)
    s = re.sub(r'\bहरेंन\b', 'हरेन्द्र', s)
    s = re.sub(r'\bहरेन्न\b', 'हरेन्द्र', s)
    s = re.sub(r'\bलोकेन्न\b', 'लोकेन्द्र', s)
    s = re.sub(r'\bसुरेन्न\b', 'सुरेन्द्र', s)
    s = re.sub(r'\bवीरेन्न\b', 'वीरेन्द्र', s)
    s = re.sub(r'\bवीरेंनी\b', 'वीरेन्द्री', s)
    s = re.sub(r'\bजोगिंन\b', 'जोगिन्द्र', s)
    s = re.sub(r'\bब्रिजेंन\b', 'बृजेन्द्र', s)
    s = re.sub(r'\bगोकलेन्न\b', 'गोकलेन्द्र', s)
    s = re.sub(r'\bजुगन्न\b', 'जुगेन्द्र', s)
    
    # 3. Pra / Pre fixes
    s = re.sub(r'\bपभु\b', 'प्रभु', s)
    s = re.sub(r'\bपललाद\b', 'प्रहलाद', s)
    s = re.sub(r'\bपेमवती\b', 'प्रेमवती', s)
    s = re.sub(r'\bपीति\b', 'प्रीति', s)
    
    # 4. Ha / Mohan / Mahesh fixes
    s = re.sub(r'\bमोलन\b', 'मोहन', s)
    s = re.sub(r'\bमोलित\b', 'मोहित', s)
    s = re.sub(r'\bमलेश\b', 'महेश', s)
    s = re.sub(r'\bरोलन\b', 'रोहन', s)
    s = re.sub(r'\bरोलताश\b', 'रोहताश', s)
    s = re.sub(r'\bनालर\b', 'नाहर', s)
    s = re.sub(r'\bमलावीर\b', 'महावीर', s)
    s = re.sub(r'\bसोलन\b', 'सोहन', s)
    s = re.sub(r'\bलरभान\b', 'हरभान', s)
    s = re.sub(r'\bलरिसिंल\b', 'हरिसिंह', s)
    s = re.sub(r'\bलरिसिंह\b', 'हरिसिंह', s)
    s = re.sub(r'\bलरि राम\b', 'हरि राम', s)
    s = re.sub(r'\bलरि\b', 'हरि', s)
    s = re.sub(r'\bलरवती\b', 'हरवती', s)
    s = re.sub(r'\bलर चन्दी\b', 'हरचन्दी', s)
    
    # Clean whitespace
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def style_worksheet(ws, title_text, is_summary=False):
    ws.views.sheetView[0].showGridLines = True
    
    header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
    header_font = Font(name="Arial", size=10, bold=True, color="FFFFFF")
    title_font = Font(name="Arial", size=13, bold=True, color="1E3A8A")
    title_fill = PatternFill(start_color="EEF2FF", end_color="EEF2FF", fill_type="solid")
    
    thin_side = Side(border_style="thin", color="D1D5DB")
    cell_border = Border(left=thin_side, right=thin_side, top=thin_side, bottom=thin_side)
    thick_bottom = Border(left=thin_side, right=thin_side, top=thin_side, bottom=Side(border_style="medium", color="1E3A8A"))
    
    ws.insert_rows(1, 2)
    max_c = ws.max_column
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=max_c)
    ws.row_dimensions[1].height = 28
    
    title_cell = ws.cell(1, 1, title_text)
    title_cell.font = title_font
    title_cell.fill = title_fill
    title_cell.alignment = Alignment(horizontal="center", vertical="center")
    
    ws.row_dimensions[3].height = 24
    for col in range(1, max_c + 1):
        c = ws.cell(3, col)
        c.fill = header_fill
        c.font = header_font
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = thick_bottom

    ws.freeze_panes = "A4"
    
    # Striping & cell styling
    stripe_fill = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")
    white_fill = PatternFill(start_color="FFFFFF", end_color="FFFFFF", fill_type="solid")
    regular_font = Font(name="Arial", size=9)
    deleted_font = Font(name="Arial", size=9, strike=True, color="9CA3AF")
    
    center_cols = {1, 2, 3, 4, 5, 6, 9, 12, 13, 14, 15, 16, 18}
    
    for row in range(4, ws.max_row + 1):
        ws.row_dimensions[row].height = 19
        is_even = (row % 2 == 0)
        row_fill = stripe_fill if is_even else white_fill
        
        status_val = str(ws.cell(row, 18).value or '') if not is_summary else ''
        is_del = 'विलोपित' in status_val or 'DELETED' in status_val.upper()
        
        for col in range(1, max_c + 1):
            cell = ws.cell(row, col)
            cell.fill = row_fill
            cell.border = cell_border
            cell.font = deleted_font if is_del else regular_font
            
            if is_summary:
                cell.alignment = Alignment(horizontal="center" if col > 1 else "left", vertical="center")
            else:
                align = "center" if col in center_cols else "left"
                cell.alignment = Alignment(horizontal=align, vertical="center")

    # Auto-adjust column widths
    for col in ws.columns:
        col_letter = get_column_letter(col[0].column)
        max_len = 0
        for cell in col:
            if cell.row < 3:
                continue
            val_str = str(cell.value or '')
            max_len = max(max_len, len(val_str))
        ws.column_dimensions[col_letter].width = max(max_len + 3, 11)

def extract_all():
    print("=" * 70)
    print("VijaySetu Master Compiler: सविता सतबीर कसाना (डीग / नगर, राजस्थान)")
    print("=" * 70)
    
    pdfs = sorted(glob.glob(os.path.join(SAVITA_FOLDER, "*.pdf")))
    print(f"Total PDFs found: {len(pdfs)}")
    
    all_voters = []
    panchayat_voters = {gp_hi: [] for gp_hi in PANCHAYAT_MAP.values()}
    panchayat_ward_stats = {}
    
    t0 = time.time()
    for idx, p in enumerate(pdfs, 1):
        fname = os.path.basename(p)
        parts = fname.replace('.pdf', '').split('-Ward No-')
        gp_en = parts[0]
        ward_num = int(parts[1])
        gp_hi = PANCHAYAT_MAP.get(gp_en, gp_en)
        
        print(f"[{idx:02d}/70] Processing {gp_hi} (Ward {ward_num})...", end="", flush=True)
        raw_voters = extract_single_pdf(p, default_ward=str(ward_num), include_deleted=True)
        print(f" -> {len(raw_voters)} voters (Serials: {raw_voters[0]['serial']}..{raw_voters[-1]['serial']})")
        
        # Verify continuous serials
        serials = [v['serial'] for v in raw_voters]
        expected = list(range(1, len(raw_voters) + 1))
        if serials != expected:
            diff = set(expected) - set(serials)
            print(f"  [WARNING] Serial gap detected in {fname}: missing {diff}")
        
        male_cnt = 0
        female_cnt = 0
        del_cnt = 0
        
        for v in raw_voters:
            n_hi = clean_deeg_text(v.get('name_hi', ''))
            r_hi = clean_deeg_text(v.get('relative_name_hi', ''))
            
            # Predict caste if not present
            caste_val = predict_rajasthan_caste(n_hi, r_hi)
            
            # Village fallback
            v_hi = v.get('village_hi', '').strip()
            if not v_hi or 'कुम्हारों' in v_hi or v_hi == '-':
                v_hi = gp_hi
                
            gender = v.get('gender', 'पुरुष')
            if 'स्त्री' in gender or 'महिला' in gender or 'F' in gender.upper():
                female_cnt += 1
            else:
                male_cnt += 1
                
            status = v.get('status', 'सक्रिय')
            if 'विलोपित' in status:
                del_cnt += 1
                
            v_cleaned = {
                'serial_global': len(all_voters) + 1,
                'epic': v.get('epic', ''),
                'panchayat': gp_hi,
                'panchayat_en': gp_en,
                'ward': str(ward_num),
                'part': v.get('part', '1'),
                'ward_serial': v['serial'],
                'name_hi': n_hi,
                'name_en': transliterate_hindi(n_hi),
                'relation': v.get('relation', 'पिता'),
                'relative_name_hi': r_hi,
                'relative_name_en': transliterate_hindi(r_hi),
                'house_no': v.get('house_no', '-'),
                'age': v.get('age', 30),
                'gender': gender,
                'caste': caste_val,
                'mobile': '',
                'village_hi': v_hi,
                'status': status
            }
            all_voters.append(v_cleaned)
            panchayat_voters[gp_hi].append(v_cleaned)
            
        panchayat_ward_stats.setdefault(gp_hi, {})[ward_num] = {
            'total': len(raw_voters),
            'male': male_cnt,
            'female': female_cnt,
            'deleted': del_cnt,
            'active': len(raw_voters) - del_cnt
        }
        
    print(f"\nSuccessfully extracted all {len(all_voters)} voters across 70 wards in {time.time()-t0:.1f}s.")
    
    # Save JSON dump
    os.makedirs(os.path.dirname(JSON_OUTPUT), exist_ok=True)
    with open(JSON_OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(all_voters, f, ensure_ascii=False, indent=2)
    print(f"JSON dump written to {JSON_OUTPUT}")
    
    # Build Multi-Sheet Master Excel
    print("\nGenerating Master Excel workbook with 10 worksheets...")
    wb = openpyxl.Workbook()
    ws_master = wb.active
    ws_master.title = "All Voters (Master)"
    
    # 1. Master Sheet
    ws_master.append(HEADERS)
    for v in all_voters:
        ws_master.append([
            v['serial_global'], v['epic'], v['panchayat'], v['ward'],
            v['part'], v['ward_serial'], v['name_hi'], v['name_en'],
            v['relation'], v['relative_name_hi'], v['relative_name_en'],
            v['house_no'], v['age'], v['gender'], v['caste'],
            v['mobile'], v['village_hi'], v['status']
        ])
    style_worksheet(ws_master, "विजयसेतु डिजिटल मतदाता सूची - सम्पूर्ण मास्टर डेटा (सविता सतबीर कसाना)")
    
    # 2. Individual Gram Panchayat Sheets
    for gp_hi, v_list in panchayat_voters.items():
        ws_gp = wb.create_sheet(title=gp_hi[:31])
        ws_gp.append(HEADERS)
        for idx, v in enumerate(v_list, 1):
            ws_gp.append([
                idx, v['epic'], v['panchayat'], v['ward'],
                v['part'], v['ward_serial'], v['name_hi'], v['name_en'],
                v['relation'], v['relative_name_hi'], v['relative_name_en'],
                v['house_no'], v['age'], v['gender'], v['caste'],
                v['mobile'], v['village_hi'], v['status']
            ])
        style_worksheet(ws_gp, f"ग्राम पंचायत: {gp_hi} - मतदाता सूची (कुल मतदाता: {len(v_list)})")
        
    # 3. Summary & Dashboard Sheet
    ws_sum = wb.create_sheet(title="Dashboard & Summary")
    sum_headers = [
        'क्र.', 'ग्राम पंचायत', 'वार्ड संख्या', 'कुल मतदाता', 'पुरुष', 'महिला', 'सक्रिय मतदाता', 'विलोपित मतदाता'
    ]
    ws_sum.append(sum_headers)
    
    s_idx = 1
    total_constituency = 0
    total_male = 0
    total_female = 0
    total_active = 0
    total_del = 0
    
    for gp_hi in PANCHAYAT_MAP.values():
        wards_dict = panchayat_ward_stats.get(gp_hi, {})
        for w_num in sorted(wards_dict.keys()):
            st = wards_dict[w_num]
            ws_sum.append([
                s_idx, gp_hi, f"वार्ड {w_num:02d}",
                st['total'], st['male'], st['female'], st['active'], st['deleted']
            ])
            s_idx += 1
            total_constituency += st['total']
            total_male += st['male']
            total_female += st['female']
            total_active += st['active']
            total_del += st['deleted']
            
    # Total row
    ws_sum.append([
        'कुल', 'सभी 8 ग्राम पंचायत', '70 वार्ड',
        total_constituency, total_male, total_female, total_active, total_del
    ])
    style_worksheet(ws_sum, "ग्राम पंचायत व वार्ड अनुसार सारांश (Constituency Summary Dashboard)", is_summary=True)
    
    print(f"Saving workbook to {OUTPUT_EXCEL}...")
    wb.save(OUTPUT_EXCEL)
    
    import shutil
    shutil.copyfile(OUTPUT_EXCEL, COPY_OUTPUT)
    print(f"Copy saved to {COPY_OUTPUT}")
    
    print("\n" + "=" * 70)
    print(f"EXTRACTION COMPLETE: {total_constituency} TOTAL VOTERS EXTRACTED")
    print(f"Male: {total_male} | Female: {total_female} | Active: {total_active} | Deleted: {total_del}")
    print("=" * 70)

if __name__ == '__main__':
    extract_all()

