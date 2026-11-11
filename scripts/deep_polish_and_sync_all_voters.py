#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Deep Scan, Linguistic Matra Polish, Transliteration Sync & Master Excel Regeneration
for all 20,881 voters of सविता सतबीर कसाना across all 70 wards (8 Gram Panchayats).
"""

import os
import sys
import json
import re
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from scripts.extract_voters_perfect import transliterate_hindi, predict_rajasthan_caste

JSON_FILE = os.path.join(BACKEND_DIR, "data", "savita_ji_all_voters.json")
OUTPUT_EXCEL = "/Users/piyush/Documents/Moxrathore_projects/vijaysetu/Master_Voters_Savita_Satbir_Kasana.xlsx"
COPY_OUTPUT = "/Users/piyush/Documents/Moxrathore_projects/vijaysetu/savita ji /Master_Combined_Voters.xlsx"

CORRECTIONS = [
    # Broken halants & spacing
    (r'विश्\s+राम', 'विश्राम'),
    (r'\bमोहममद\b', 'मोहम्मद'),
    (r'\bमौहममद\b', 'मोहम्मद'),
    (r'\bमहम्मद\b', 'मोहम्मद'),
    (r'\bमयहममद\b', 'मोहम्मद'),
    
    # Supplement font da -> ee matra
    (r'\bवसडमा\b', 'वसीमा'),
    (r'\bमनडषा\b', 'मनीषा'),
    (r'\bतालडम\b', 'तालीम'),
    (r'\bतसलडम\b', 'तसलीम'),
    (r'\bतसलडमा\b', 'तसलीमा'),
    (r'\bजिलसाना\b', 'दिलशाना'),
    (r'\bअफसरड\b', 'अफसरी'),
    (r'\bशरडफ\b', 'शरीफ'),
    (r'\bजहडर\b', 'जहीर'),
    (r'\bउमरदडन\b', 'उमरदीन'),
    (r'\bआसडन\b', 'आसीन'),
    (r'\bअनडस\b', 'अनीस'),
    (r'\bरुकदडन\b', 'रुकदीन'),
    (r'\bरहडद\b', 'रहीद'),
    (r'\bरसडमर\b', 'रसीमा'),
    (r'\bरोबडन\b', 'रोबीन'),
    (r'\bशचककन\b', 'शौकीन'),
    (r'\bकुसरद\b', 'खुर्शीद'),
    (r'\bइन्द्रस\b', 'इदरीस'),
    (r'\bसरसमल\b', 'कासम'),
    (r'\bजज़बेर\b', 'जब्बार'),
    (r'\bतरतडला\b', 'तरतीला'),
    (r'\bसारिप\b', 'सारिफ'),
    (r'\bशौबि\b', 'शोएब'),
    (r'\bसेसुला\b', 'फैजुल्ला'),
    (r'\bआयसा\b', 'आयशा'),
    (r'\bजमसेद\b', 'जमशेद'),
    (r'\bमोज खान\b', 'मौज खान'),
    (r'\bसाहीन\b', 'शाहीन'),
    (r'\bसाहिला\b', 'शाहिला'),
    (r'\bसानिस्ता\b', 'दानिस्ता'),
    (r'\bगुलपशा\b', 'गुलफ्शा'),
    (r'\bहसा\b', 'हफ्सा'),
    
    # Pra / Pre conjuncts
    (r'\bपेम\b', 'प्रेम'),
    (r'\bपेम\s+लता\b', 'प्रेमलता'),
    (r'\bपेमवती\b', 'प्रेमवती'),
    (r'\bपीति\b', 'प्रीति'),
    (r'\bपभु\b', 'प्रभु'),
    (r'\bपललाद\b', 'प्रहलाद'),
    
    # Deeg colloquialisms
    (r'(\b\w+)सिंल\b', r'\1 सिंह'),
    (r'\bसिंल\b', 'सिंह'),
    (r'\bसालब\b', 'साहब'),
    (r'\bसामल\b', 'साहब'),
    (r'\bविश्वेन्न\b', 'विश्वेन्द्र'),
    (r'\bराजेंन\b', 'राजेन्द्र'),
    (r'\bगजेन्न\b', 'गजेन्द्र'),
    (r'\bगजेंन\b', 'गजेन्द्र'),
    (r'\bपुष्पेंन\b', 'पुष्पेन्द्र'),
    (r'\bविजेंन\b', 'विजेन्द्र'),
    (r'\bहरेंन\b', 'हरेन्द्र'),
    (r'\bहरेन्न\b', 'हरेन्द्र'),
    (r'\bलोकेन्न\b', 'लोकेन्द्र'),
    (r'\bसुरेन्न\b', 'सुरेन्द्र'),
    (r'\bवीरेन्न\b', 'वीरेन्द्र'),
    (r'\bवीरेंनी\b', 'वीरेन्द्री'),
    (r'\bजोगिंन\b', 'जोगिन्द्र'),
    (r'\bब्रिजेंन\b', 'बृजेन्द्र'),
    (r'\bगोकलेन्न\b', 'गोकलेन्द्र'),
    (r'\bजुगन्न\b', 'जुगेन्द्र'),
    (r'\bमोलन\b', 'मोहन'),
    (r'\bमोलित\b', 'मोहित'),
    (r'\bमलेश\b', 'महेश'),
    (r'\bरोलन\b', 'रोहन'),
    (r'\bरोलताश\b', 'रोहताश'),
    (r'\bनालर\b', 'नाहर'),
    (r'\bमलावीर\b', 'महावीर'),
    (r'\bसोलन\b', 'सोहन'),
    (r'\bलरभान\b', 'हरभान'),
    (r'\bलरिसिंल\b', 'हरिसिंह'),
    (r'\bलरिसिंह\b', 'हरिसिंह'),
    (r'\bलरि\s+राम\b', 'हरि राम'),
    (r'\bलरि\b', 'हरि'),
    (r'\bलरवती\b', 'हरवती'),
    (r'\bलर\s+चन्दी\b', 'हरचन्दी'),
    
    # Specific OCR corrupted words
    (r'\bुाुीश\s+राम\b', 'जगदीश राम'),
    (r'\bेाेाहजान\b', 'शाहजहां'),
    (r'\bेादीक\b', 'सादिक'),
    (r'\bुफुसिया\b', 'फुंसिया'),
    (r'\bफुचनसजर\b', 'फुंसिया'),
    (r'\bिरकू\b', 'रिकी'),
    (r'\bपुनियािॅ\b', 'पुनिया'),
    (r'\bविाी\b', 'विमला'),
    (r'\bमूित\b', 'मूर्ति')
]

HEADERS = [
    'क्रमांक', 'पहचान पत्र क्रमांक (EPIC No)', 'ग्राम पंचायत', 'वार्ड संख्या',
    'बूथ / भाग संख्या', 'वार्ड में क्र.', 'मतदाता का नाम (हिंदी)', 'मतदाता का नाम (English)',
    'संबंध प्रकार', 'संबंधी का नाम (हिंदी)', 'संबंधी का नाम (English)',
    'मकान संख्या', 'आयु', 'लिंग', 'जाति', 'मोबाइल नंबर', 'गाँव / मोहल्ला', 'स्थिति'
]

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

    for col in ws.columns:
        col_letter = get_column_letter(col[0].column)
        max_len = 0
        for cell in col:
            if cell.row < 3:
                continue
            val_str = str(cell.value or '')
            max_len = max(max_len, len(val_str))
        ws.column_dimensions[col_letter].width = max(max_len + 3, 11)

def polish_and_sync():
    print(f"Loading {JSON_FILE}...")
    with open(JSON_FILE, 'r', encoding='utf-8') as f:
        voters = json.load(f)
        
    print(f"Loaded {len(voters)} voters. Running deep linguistic polish...")
    
    corrected_count = 0
    panchayat_voters = {}
    panchayat_ward_stats = {}
    
    for idx, v in enumerate(voters):
        v_changed = False
        
        # Polish Hindi Name
        n_hi = v.get('name_hi', '').strip()
        orig_n_hi = n_hi
        for pat, repl in CORRECTIONS:
            n_hi = re.sub(pat, repl, n_hi)
        n_hi = re.sub(r'\s+', ' ', n_hi).strip()
        
        if not n_hi or n_hi in ['मतदाता', '-']:
            n_hi = 'नाम उपलब्ध नहीं (निर्वाचन आयोग)'
            
        if n_hi != orig_n_hi:
            v['name_hi'] = n_hi
            v_changed = True
            
        # Polish Relative Name
        r_hi = v.get('relative_name_hi', '').strip()
        orig_r_hi = r_hi
        for pat, repl in CORRECTIONS:
            r_hi = re.sub(pat, repl, r_hi)
        r_hi = re.sub(r'\s+', ' ', r_hi).strip()
        
        if not r_hi:
            r_hi = '-'
            
        if r_hi != orig_r_hi:
            v['relative_name_hi'] = r_hi
            v_changed = True
            
        # Clean EPIC if placeholder
        epic = v.get('epic', '').strip()
        if not epic or epic.startswith('VOTER_') or epic.startswith('UNREADABLE_'):
            epic = f"SAVITA-W{v['ward']}-{int(v['ward_serial']):03d}"
            v['epic'] = epic
            v_changed = True
            
        # Synchronize English transliterations
        if v_changed or not v.get('name_en'):
            if n_hi == 'नाम उपलब्ध नहीं (निर्वाचन आयोग)':
                v['name_en'] = 'Name Not Available'
            else:
                v['name_en'] = transliterate_hindi(n_hi)
                
        if v_changed or not v.get('relative_name_en'):
            if r_hi == '-':
                v['relative_name_en'] = '-'
            else:
                v['relative_name_en'] = transliterate_hindi(r_hi)
                
        # Caste
        if not v.get('caste'):
            v['caste'] = predict_rajasthan_caste(n_hi, r_hi)
            
        if v_changed:
            corrected_count += 1
            
        gp_hi = v['panchayat']
        panchayat_voters.setdefault(gp_hi, []).append(v)
        
        w_num = int(v['ward'])
        st = panchayat_ward_stats.setdefault(gp_hi, {}).setdefault(w_num, {
            'total': 0, 'male': 0, 'female': 0, 'deleted': 0, 'active': 0
        })
        st['total'] += 1
        g = v.get('gender', 'पुरुष')
        if 'स्त्री' in g or 'महिला' in g or 'F' in g.upper():
            st['female'] += 1
        else:
            st['male'] += 1
            
        if 'विलोपित' in v.get('status', ''):
            st['deleted'] += 1
        else:
            st['active'] += 1
            
    print(f"Deep Polish Complete: {corrected_count} records refined.")
    
    # Save back to JSON
    with open(JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(voters, f, ensure_ascii=False, indent=2)
    print(f"Updated JSON saved to {JSON_FILE}")
    
    # Regenerate Master Multi-Sheet Excel
    print("\nRegenerating Master Excel workbook with 10 worksheets...")
    wb = openpyxl.Workbook()
    ws_master = wb.active
    ws_master.title = "All Voters (Master)"
    
    ws_master.append(HEADERS)
    for v in voters:
        ws_master.append([
            v['serial_global'], v['epic'], v['panchayat'], v['ward'],
            v['part'], v['ward_serial'], v['name_hi'], v['name_en'],
            v['relation'], v['relative_name_hi'], v['relative_name_en'],
            v['house_no'], v['age'], v['gender'], v['caste'],
            v['mobile'], v['village_hi'], v['status']
        ])
    style_worksheet(ws_master, "विजयसेतु डिजिटल मतदाता सूची - सम्पूर्ण मास्टर डेटा (सविता सतबीर कसाना)")
    
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
    
    for gp_hi in sorted(panchayat_ward_stats.keys()):
        wards_dict = panchayat_ward_stats[gp_hi]
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

if __name__ == '__main__':
    polish_and_sync()
