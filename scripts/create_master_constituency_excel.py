#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VijaySetu Master Electoral Roll Compiler:
Combines all Gram Panchayats of Panchayat Samiti Ward 22 (खेराज राम हुड्डा):
1. सांभरा (from doc00229020261019003738_voters.xlsx)
2. अकारली बक्शीराम (from New Folder With Items / AKARLI BAKSHIRAM PDFs)
3. बागुंडी (from New Folder With Items / BAGUNDI PDFs + Bagundi Excels with Mobile/Caste)
4. खेड़ (from New Folder With Items / WithPhoto_KHER PDFs)

Generates a master, publication-ready multi-sheet Excel workbook.
"""

import os
import sys
import glob
import re
import json
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from scripts.extract_voters_perfect import (
    extract_single_pdf, transliterate_hindi, predict_rajasthan_caste
)

NEW_FOLDER = "/Users/piyush/Documents/Moxrathore_projects/vijaysetu/New Folder With Items"
SAMBHARA_EXCEL = "/Users/piyush/Documents/Moxrathore_projects/vijaysetu/doc00229020261019003738_voters.xlsx"
OUTPUT_EXCEL = "/Users/piyush/Documents/Moxrathore_projects/vijaysetu/Master_Voters_Panchayat_Samiti_22.xlsx"
COPY_OUTPUT = os.path.join(NEW_FOLDER, "Master_Combined_Voters.xlsx")

HEADERS = [
    'क्रमांक', 'पहचान पत्र क्रमांक (EPIC No)', 'ग्राम पंचायत', 'वार्ड संख्या',
    'बूथ / भाग संख्या', 'वार्ड में क्र.', 'मतदाता का नाम (हिंदी)', 'मतदाता का नाम (English)',
    'संबंध प्रकार', 'संबंधी का नाम (हिंदी)', 'संबंधी का नाम (English)',
    'मकान संख्या', 'आयु', 'लिंग', 'जाति', 'मोबाइल नंबर', 'गाँव / मोहल्ला', 'स्थिति'
]

def load_bagundi_excel_meta():
    meta = {}
    for w in [1, 2, 3]:
        fname = os.path.join(NEW_FOLDER, f'Bagundi Ward Number 0{w}.xlsx')
        if not os.path.exists(fname):
            continue
        wb = openpyxl.load_workbook(fname, data_only=True)
        sname = 'Ward Number 01' if w == 1 else 'Voter List'
        sheet = wb[sname]
        start_r = 7 if w in [1, 2] else 10
        for r in range(start_r, sheet.max_row + 1):
            s_val = sheet.cell(r, 1).value
            name = sheet.cell(r, 4).value
            caste = sheet.cell(r, 9).value
            mob = sheet.cell(r, 10).value
            head = sheet.cell(r, 3).value
            if s_val and name:
                try:
                    s_int = int(s_val)
                    meta[(w, s_int)] = {
                        'caste': str(caste or '').strip(),
                        'mobile': str(mob or '').strip(),
                        'family_head': str(head or '').strip()
                    }
                except:
                    pass
    return meta

def load_sambhara_voters():
    voters = []
    if not os.path.exists(SAMBHARA_EXCEL):
        print(f"Warning: {SAMBHARA_EXCEL} not found.")
        return voters
    wb = openpyxl.load_workbook(SAMBHARA_EXCEL, data_only=True)
    sheet = wb['All Voters']
    for r in range(2, sheet.max_row + 1):
        epic = sheet.cell(r, 1).value
        ward = sheet.cell(r, 2).value
        part = sheet.cell(r, 3).value
        serial = sheet.cell(r, 4).value
        name_en = sheet.cell(r, 5).value
        name_hi = sheet.cell(r, 6).value
        age = sheet.cell(r, 7).value
        gender = sheet.cell(r, 8).value
        rel_type = sheet.cell(r, 9).value
        rel_en = sheet.cell(r, 10).value
        rel_hi = sheet.cell(r, 11).value
        house = sheet.cell(r, 12).value
        mob = sheet.cell(r, 14).value
        caste = sheet.cell(r, 15).value
        village = sheet.cell(r, 18).value or sheet.cell(r, 17).value
        
        n_hi = str(name_hi or '').strip()
        r_hi = str(rel_hi or '').strip()
        r_type = str(rel_type or 'पिता').strip()
        g_val = str(gender or 'पुरुष').strip()
        
        FEMALE_ENDINGS = {'कुमारी', 'देवी', 'बाई', 'कंवर', 'पार्वती', 'बेगम', 'सुआ', 'मुन्नी', 'पुष्पा', 'सुमित्रा', 'राधा', 'कमला', 'गीता', 'ममता', 'लक्ष्मी', 'संतोष', 'मोहिनी', 'तारा', 'चोथकी', 'सुगणी', 'नोजी', 'चुनी', 'इमरती', 'सीता', 'सुशीला', 'शांति', 'मंजू', 'रेखा', 'आशा', 'पूजा', 'सुमन', 'केसर', 'धापू', 'धापु', 'बबरी', 'सतकी', 'प्यारकी', 'हस्ती', 'रूपा', 'गुलाबी', 'चंदा', 'गौरी', 'ललिता', 'उर्मिला', 'भंवरी', 'सोनू', 'अंजू', 'किरण', 'संगीता', 'कविता', 'शारदा', 'टीकू', 'जसोदा', 'कौशल्या'}
        MALE_ENDINGS = {'राम', 'सिंह', 'कुमार', 'लाल', 'चन्द', 'चंद', 'नाथ', 'प्रसाद', 'प्रकाश', 'दान', 'मल', 'खां', 'खान', 'दीन', 'दास', 'करण', 'भंवर', 'जीत', 'दीपक', 'दिलीप', 'नरेश', 'सुरेश', 'रमेश', 'महेश', 'राजेश', 'दिनेश', 'मुकेश', 'कल्याण', 'मदन', 'हर्षित', 'लक्ष्मण', 'रणजीत', 'घेवर', 'कालू', 'तेजा', 'वंशा', 'सावला', 'जैसा', 'भेराराम', 'केशाराम'}
        tokens = n_hi.split()
        last_tok = tokens[-1] if tokens else ''

        if r_type == 'पति':
            g_val = 'स्त्री'
        elif last_tok in FEMALE_ENDINGS or any(fem in n_hi for fem in ['देवी', 'कुमारी', 'बाई', 'कंवर']):
            g_val = 'स्त्री'
        elif last_tok in MALE_ENDINGS:
            g_val = 'पुरुष'

        voters.append({
            'epic': str(epic or '').strip(),
            'panchayat': 'सांभरा',
            'ward': str(ward or '1').strip(),
            'part': str(part or '108').strip(),
            'ward_serial': serial,
            'name_hi': n_hi,
            'name_en': re.sub(r'[\u0900-\u097F\u25CC]', '', transliterate_hindi(n_hi)).strip(),
            'relation': r_type,
            'rel_name_hi': r_hi,
            'rel_name_en': re.sub(r'[\u0900-\u097F\u25CC]', '', transliterate_hindi(r_hi)).strip(),
            'house_no': str(house or '-').strip(),
            'age': age,
            'gender': g_val,
            'caste': str(caste or '').strip(),
            'mobile': str(mob or '').strip(),
            'village': str(village or '').strip(),
            'status': 'सक्रिय'
        })
    return voters

def main():
    print("Step 1: Loading Bagundi manual survey metadata (Caste & Mobile)...")
    bagundi_meta = load_bagundi_excel_meta()
    print(f"Loaded survey metadata for {len(bagundi_meta)} Bagundi voters.")

    all_voters = []
    panchayat_buckets = {
        'अकारली बक्शीराम': [],
        'बागुंडी': [],
        'खेड़': [],
        'सांभरा': []
    }

    # Step 2: Extract PDFs from New Folder With Items
    pdf_files = sorted(glob.glob(os.path.join(NEW_FOLDER, "*.pdf")))
    print(f"Step 2: Processing {len(pdf_files)} PDFs in New Folder With Items...")

    for pdf in pdf_files:
        fname = os.path.basename(pdf)
        # Determine Panchayat and Ward
        if "AKARLI" in fname:
            p_name = 'अकारली बक्शीराम'
            m = re.search(r'Ward No-0*(\d+)', fname)
            ward_num = int(m.group(1)) if m else 1
        elif "BAGUNDI" in fname:
            p_name = 'बागुंडी'
            m = re.search(r'Ward No-0*(\d+)', fname)
            ward_num = int(m.group(1)) if m else 1
        elif "KHER" in fname:
            p_name = 'खेड़'
            m = re.search(r'Ward No-0*(\d+)', fname)
            ward_num = int(m.group(1)) if m else 1
        else:
            p_name = 'अन्य'
            ward_num = 1

        print(f"  Extracting {fname} (Panchayat: {p_name}, Ward: {ward_num})...")
        # Include deleted voters so we have complete records matching SEC roll
        pdf_voters = extract_single_pdf(pdf, default_ward=str(ward_num), include_deleted=True)
        print(f"    -> Extracted {len(pdf_voters)} voters.")

        for v in pdf_voters:
            serial = v.get('serial')
            name_hi = v.get('name_hi', '')
            rel_hi = v.get('relative_name_hi', '')
            village = v.get('गाँव / मोहल्ला', '')
            
            caste = ""
            mobile = ""
            if p_name == 'बागुंडी':
                meta = bagundi_meta.get((ward_num, serial), {})
                caste = meta.get('caste', '')
                mobile = meta.get('mobile', '')
            
            if not caste:
                caste = predict_rajasthan_caste(name_hi, rel_hi, village)

            # Smart Gender Reconciliation
            gender = v.get('gender', 'पुरुष')
            rel_type = v.get('relation', 'पिता')
            tokens = name_hi.split()
            last_tok = tokens[-1] if tokens else ''
            
            FEMALE_ENDINGS = {'कुमारी', 'देवी', 'बाई', 'कंवर', 'पार्वती', 'बेगम', 'सुआ', 'मुन्नी', 'पुष्पा', 'सुमित्रा', 'राधा', 'कमला', 'गीता', 'ममता', 'लक्ष्मी', 'संतोष', 'मोहिनी', 'तारा', 'चोथकी', 'सुगणी', 'नोजी', 'चुनी', 'इमरती', 'सीता', 'सुशीला', 'शांति', 'मंजू', 'रेखा', 'आशा', 'पूजा', 'सुमन', 'केसर', 'धापू', 'धापु', 'बबरी', 'सतकी', 'प्यारकी', 'हस्ती', 'रूपा', 'गुलाबी', 'चंदा', 'गौरी', 'ललिता', 'उर्मिला', 'भंवरी', 'सोनू', 'अंजू', 'किरण', 'संगीता', 'कविता', 'शारदा', 'टीकू', 'जसोदा', 'कौशल्या'}
            MALE_ENDINGS = {'राम', 'सिंह', 'कुमार', 'लाल', 'चन्द', 'चंद', 'नाथ', 'प्रसाद', 'प्रकाश', 'दान', 'मल', 'खां', 'खान', 'दीन', 'दास', 'करण', 'भंवर', 'जीत', 'दीपक', 'दिलीप', 'नरेश', 'सुरेश', 'रमेश', 'महेश', 'राजेश', 'दिनेश', 'मुकेश', 'कल्याण', 'मदन', 'हर्षित', 'लक्ष्मण', 'रणजीत', 'घेवर', 'कालू', 'तेजा', 'वंशा', 'सावला', 'जैसा', 'भेराराम', 'केशाराम'}
            
            if rel_type == 'पति':
                gender = 'स्त्री'
            elif last_tok in FEMALE_ENDINGS or any(fem in name_hi for fem in ['देवी', 'कुमारी', 'बाई', 'कंवर']):
                gender = 'स्त्री'
            elif last_tok in MALE_ENDINGS:
                gender = 'पुरुष'

            clean_name_en = re.sub(r'[\u0900-\u097F\u25CC]', '', transliterate_hindi(name_hi)).strip()
            clean_rel_en = re.sub(r'[\u0900-\u097F\u25CC]', '', transliterate_hindi(rel_hi)).strip()

            record = {
                'epic': v.get('epic', ''),
                'panchayat': p_name,
                'ward': str(ward_num),
                'part': str(v.get('part', '1')),
                'ward_serial': serial,
                'name_hi': name_hi,
                'name_en': clean_name_en,
                'relation': rel_type,
                'rel_name_hi': rel_hi,
                'rel_name_en': clean_rel_en,
                'house_no': v.get('house_no', '-'),
                'age': v.get('age'),
                'gender': gender,
                'caste': caste,
                'mobile': mobile,
                'village': village,
                'status': v.get('स्थिति', 'सक्रिय')
            }
            panchayat_buckets[p_name].append(record)
            all_voters.append(record)

    # Step 3: Load Sambhara voters from doc00229020261019003738_voters.xlsx
    print("Step 3: Loading Sambhara voters from existing pristine excel...")
    sambhara_voters = load_sambhara_voters()
    print(f"Loaded {len(sambhara_voters)} voters for सांभरा.")
    panchayat_buckets['सांभरा'] = sambhara_voters
    all_voters.extend(sambhara_voters)

    print(f"\n================ SUMMARY ================")
    print(f"अकारली बक्शीराम : {len(panchayat_buckets['अकारली बक्शीराम'])} voters")
    print(f"बागुंडी         : {len(panchayat_buckets['बागुंडी'])} voters")
    print(f"खेड़            : {len(panchayat_buckets['खेड़'])} voters")
    print(f"सांभरा          : {len(panchayat_buckets['सांभरा'])} voters")
    print(f"TOTAL MASTER    : {len(all_voters)} voters across Panchayat Samiti Ward 22!")
    print(f"=========================================\n")

    # Step 4: Build Excel Workbook
    wb = openpyxl.Workbook()
    # Remove default sheet
    wb.remove(wb.active)

    # Styles
    font_header = Font(name='Arial', size=11, bold=True, color='FFFFFF')
    fill_header = PatternFill(start_color='1F4E79', end_color='1F4E79', fill_type='solid') # Deep Navy
    font_data = Font(name='Arial', size=10)
    thin_border = Border(
        left=Side(style='thin', color='D9D9D9'),
        right=Side(style='thin', color='D9D9D9'),
        top=Side(style='thin', color='D9D9D9'),
        bottom=Side(style='thin', color='D9D9D9')
    )
    align_center = Alignment(horizontal='center', vertical='center')
    align_left = Alignment(horizontal='left', vertical='center')

    def write_voter_sheet(ws, title, voters_sub):
        ws.title = title
        ws.append(HEADERS)
        for col_idx in range(1, len(HEADERS) + 1):
            cell = ws.cell(1, col_idx)
            cell.font = font_header
            cell.fill = fill_header
            cell.alignment = align_center

        for idx, v in enumerate(voters_sub, start=1):
            row_data = [
                idx,
                v['epic'],
                v['panchayat'],
                v['ward'],
                v['part'],
                v['ward_serial'],
                v['name_hi'],
                v['name_en'],
                v['relation'],
                v['rel_name_hi'],
                v['rel_name_en'],
                v['house_no'],
                v['age'],
                v['gender'],
                v['caste'],
                v['mobile'],
                v['village'],
                v['status']
            ]
            ws.append(row_data)
            row_num = idx + 1
            for c_idx in range(1, len(row_data) + 1):
                c = ws.cell(row_num, c_idx)
                c.font = font_data
                c.border = thin_border
                if c_idx in [1, 3, 4, 5, 6, 9, 12, 13, 14, 18]:
                    c.alignment = align_center
                else:
                    c.alignment = align_left

        # Auto width
        for col in ws.columns:
            max_len = 0
            col_letter = get_column_letter(col[0].column)
            for cell in col[:100]: # Sample 100
                v_str = str(cell.value or '')
                if len(v_str) > max_len:
                    max_len = len(v_str)
            ws.column_dimensions[col_letter].width = max(max_len + 4, 12)

    # 1. Master Sheet
    print("Generating Sheet: All Voters (Master)...")
    ws_master = wb.create_sheet(title="All Voters (Master)")
    write_voter_sheet(ws_master, "All Voters (Master)", all_voters)

    # 2. Panchayat Sheets
    for p_name in ['अकारली बक्शीराम', 'बागुंडी', 'खेड़', 'सांभरा']:
        print(f"Generating Sheet: {p_name} ({len(panchayat_buckets[p_name])} voters)...")
        ws_p = wb.create_sheet(title=p_name[:31])
        write_voter_sheet(ws_p, p_name[:31], panchayat_buckets[p_name])

    # 3. Summary Dashboard Sheet
    print("Generating Sheet: Dashboard & Summary...")
    ws_dash = wb.create_sheet(title="Dashboard & Summary")
    dash_header = Font(name='Arial', size=12, bold=True, color='FFFFFF')
    dash_fill = PatternFill(start_color='2C3E50', end_color='2C3E50', fill_type='solid')

    ws_dash.append(['पंचायत समिति सदस्य क्षेत्र - वार्ड 22 (खेराज राम हुड्डा)', '', '', '', ''])
    ws_dash.append(['समग्र मतदाता सांख्यिकी सारांश', '', '', '', ''])
    ws_dash.append([])
    ws_dash.append(['क्र.', 'ग्राम पंचायत', 'कुल वार्ड', 'कुल मतदाता', 'पुरुष', 'महिला', 'अन्य/अज्ञात'])

    for c in range(1, 8):
        cell = ws_dash.cell(4, c)
        cell.font = dash_header
        cell.fill = dash_fill
        cell.alignment = align_center

    dash_rows = [
        (1, 'अकारली बक्शीराम', 7, panchayat_buckets['अकारली बक्शीराम']),
        (2, 'बागुंडी', 3, panchayat_buckets['बागुंडी']),
        (3, 'खेड़', 7, panchayat_buckets['खेड़']),
        (4, 'सांभरा', 7, panchayat_buckets['सांभरा'])
    ]

    r_idx = 5
    for num, p_name, w_count, p_voters in dash_rows:
        male = sum(1 for v in p_voters if v['gender'] == 'पुरुष')
        female = sum(1 for v in p_voters if v['gender'] == 'स्त्री')
        other = len(p_voters) - (male + female)
        ws_dash.append([num, p_name, w_count, len(p_voters), male, female, other])
        for c in range(1, 8):
            cell = ws_dash.cell(r_idx, c)
            cell.font = font_data
            cell.border = thin_border
            cell.alignment = align_center
        r_idx += 1

    # Total Row
    total_male = sum(1 for v in all_voters if v['gender'] == 'पुरुष')
    total_female = sum(1 for v in all_voters if v['gender'] == 'स्त्री')
    ws_dash.append(['', 'कुल महायोग (Grand Total)', 24, len(all_voters), total_male, total_female, len(all_voters)-(total_male+total_female)])
    tot_row = r_idx
    for c in range(1, 8):
        cell = ws_dash.cell(tot_row, c)
        cell.font = Font(name='Arial', size=11, bold=True)
        cell.fill = PatternFill(start_color='D9E1F2', end_color='D9E1F2', fill_type='solid')
        cell.alignment = align_center

    ws_dash.column_dimensions['A'].width = 8
    ws_dash.column_dimensions['B'].width = 25
    ws_dash.column_dimensions['C'].width = 14
    ws_dash.column_dimensions['D'].width = 18
    ws_dash.column_dimensions['E'].width = 16
    ws_dash.column_dimensions['F'].width = 16
    ws_dash.column_dimensions['G'].width = 16

    # Save to both locations
    print(f"\nSaving Master Workbook to {OUTPUT_EXCEL}...")
    wb.save(OUTPUT_EXCEL)
    print(f"Copying to {COPY_OUTPUT}...")
    wb.save(COPY_OUTPUT)
    print(f"SUCCESS: Master Excel compiled with {len(all_voters)} total voters!")

if __name__ == '__main__':
    main()

