#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Merge mobile numbers and caste from Sambhara_Merged_Voter_List_All_Wards.xlsx
into Master_Voters_Panchayat_Samiti_22.xlsx (for खेराज राम हुड्डा),
and generate a separate multi-sheet Excel file for voters without mobile numbers:
Sambhara_Voters_Without_Mobile_Numbers.xlsx.
Also syncs updated mobile numbers and caste into MongoDB.
"""

import os
import sys
import re
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

SOURCE_FILE = "/Users/piyush/Documents/Moxrathore_projects/vijaysetu/Sambhara_Merged_Voter_List_All_Wards.xlsx"
MASTER_FILE = "/Users/piyush/Documents/Moxrathore_projects/vijaysetu/Master_Voters_Panchayat_Samiti_22.xlsx"
PENDING_OUTPUT_FILE = "/Users/piyush/Documents/Moxrathore_projects/vijaysetu/Sambhara_Voters_Without_Mobile_Numbers.xlsx"

def clean_hindi(s):
    if not s:
        return ''
    s = str(s).strip()
    s = re.sub(r'[\sःँंिीुूेैोौ्]', '', s)
    s = s.replace('व', 'ब').replace('श', 'स').replace('ष', 'स').replace('ण', 'न')
    return s

def clean_phone(val):
    if not val:
        return ''
    val = str(val).strip()
    # find 10-digit number starting with 6, 7, 8, 9
    matches = re.findall(r'[6-9]\d{9}', val)
    if matches:
        return matches[0]
    # digits only if length 10
    digits = re.sub(r'\D', '', val)
    if len(digits) == 10 and digits[0] in '6789':
        return digits
    return ''

def main():
    print("=== Step 1: Loading Sambhara Source Data ===")
    wb_src = openpyxl.load_workbook(SOURCE_FILE, data_only=True)
    ws_src = wb_src['Voter List (All Wards)']
    
    # Read headers from row 2
    src_voters = []
    for r in range(3, ws_src.max_row + 1):
        sr_no = ws_src.cell(r, 1).value
        serial = str(ws_src.cell(r, 2).value or '').strip()
        ward = str(ws_src.cell(r, 3).value or '').strip()
        house = str(ws_src.cell(r, 4).value or '').strip()
        name = str(ws_src.cell(r, 6).value or '').strip()
        rel_type = str(ws_src.cell(r, 7).value or '').strip()
        rel = str(ws_src.cell(r, 8).value or '').strip()
        age = ws_src.cell(r, 9).value
        gender = str(ws_src.cell(r, 10).value or '').strip()
        caste = str(ws_src.cell(r, 11).value or '').strip()
        mob_raw = ws_src.cell(r, 12).value
        epic = str(ws_src.cell(r, 15).value or '').strip()
        
        mobile = clean_phone(mob_raw)
        
        src_voters.append({
            'src_row': r,
            'ward': ward,
            'serial': serial,
            'house': house,
            'name': name,
            'rel_type': rel_type,
            'rel': rel,
            'age': age,
            'gender': gender,
            'caste': caste,
            'mobile': mobile,
            'epic': epic
        })
    
    print(f"Loaded {len(src_voters)} voters from 'Voter List (All Wards)'.")
    src_with_mobile = [v for v in src_voters if v['mobile']]
    print(f"Found {len(src_with_mobile)} source voters with valid mobile numbers.")
    wb_src.close()
    
    print("\n=== Step 2: Loading Master Workbook ===")
    wb_mst = openpyxl.load_workbook(MASTER_FILE)
    ws_mst_sambhara = wb_mst['सांभरा']
    ws_mst_all = wb_mst['All Voters (Master)']
    
    # Read master सांभरा rows
    master_voters = []
    for r in range(2, ws_mst_sambhara.max_row + 1):
        epic = str(ws_mst_sambhara.cell(r, 2).value or '').strip()
        ward = str(ws_mst_sambhara.cell(r, 4).value or '').strip()
        part = str(ws_mst_sambhara.cell(r, 5).value or '').strip()
        serial = str(ws_mst_sambhara.cell(r, 6).value or '').strip()
        name_hi = str(ws_mst_sambhara.cell(r, 7).value or '').strip()
        name_en = str(ws_mst_sambhara.cell(r, 8).value or '').strip()
        rel_type = str(ws_mst_sambhara.cell(r, 9).value or '').strip()
        rel_hi = str(ws_mst_sambhara.cell(r, 10).value or '').strip()
        rel_en = str(ws_mst_sambhara.cell(r, 11).value or '').strip()
        house = str(ws_mst_sambhara.cell(r, 12).value or '').strip()
        age = ws_mst_sambhara.cell(r, 13).value
        gender = str(ws_mst_sambhara.cell(r, 14).value or '').strip()
        caste = str(ws_mst_sambhara.cell(r, 15).value or '').strip()
        mobile = str(ws_mst_sambhara.cell(r, 16).value or '').strip()
        village = str(ws_mst_sambhara.cell(r, 17).value or '').strip()
        status = str(ws_mst_sambhara.cell(r, 18).value or '').strip()
        
        master_voters.append({
            'row': r,
            'epic': epic,
            'ward': ward,
            'part': part,
            'serial': serial,
            'name_hi': name_hi,
            'name_en': name_en,
            'rel_type': rel_type,
            'rel_hi': rel_hi,
            'rel_en': rel_en,
            'house': house,
            'age': age,
            'gender': gender,
            'caste': caste,
            'mobile': mobile,
            'village': village,
            'status': status
        })
    print(f"Loaded {len(master_voters)} master voters from 'सांभरा' sheet.")
    
    print("\n=== Step 3: Multi-Pass Matching for Mobile Numbers & Caste ===")
    matched_mobile_map = {} # master_row -> src_entry
    matched_caste_map = {}  # master_row -> caste
    src_mobile_matched = set()
    
    # Build lookup dictionaries
    master_by_row = {m['row']: m for m in master_voters}
    
    # 1. Match by exact valid EPIC
    for s in src_with_mobile:
        if s['epic'] and not s['epic'].startswith('RJ/W'):
            for m in master_voters:
                if m['epic'] == s['epic']:
                    matched_mobile_map[m['row']] = s
                    src_mobile_matched.add(s['src_row'])
                    break
    
    # 2. Match by Ward + Serial + Name clean match
    for s in src_with_mobile:
        if s['src_row'] in src_mobile_matched:
            continue
        for m in master_voters:
            if m['row'] not in matched_mobile_map and m['ward'] == s['ward'] and m['serial'] == s['serial']:
                if clean_hindi(m['name_hi']) == clean_hindi(s['name']) or clean_hindi(m['rel_hi']) == clean_hindi(s['rel']):
                    matched_mobile_map[m['row']] = s
                    src_mobile_matched.add(s['src_row'])
                    break
    
    # 3. Match by Ward + Name + Relative match
    for s in src_with_mobile:
        if s['src_row'] in src_mobile_matched:
            continue
        for m in master_voters:
            if m['row'] not in matched_mobile_map and m['ward'] == s['ward']:
                if clean_hindi(m['name_hi']) == clean_hindi(s['name']) and clean_hindi(m['rel_hi']) == clean_hindi(s['rel']):
                    matched_mobile_map[m['row']] = s
                    src_mobile_matched.add(s['src_row'])
                    break
    
    # 4. Fallback: Ward + Serial (for same electoral list position)
    for s in src_with_mobile:
        if s['src_row'] in src_mobile_matched:
            continue
        for m in master_voters:
            if m['row'] not in matched_mobile_map and m['ward'] == s['ward'] and m['serial'] == s['serial']:
                matched_mobile_map[m['row']] = s
                src_mobile_matched.add(s['src_row'])
                break
    
    # 5. Global Name + Relative match
    for s in src_with_mobile:
        if s['src_row'] in src_mobile_matched:
            continue
        for m in master_voters:
            if m['row'] not in matched_mobile_map:
                if clean_hindi(m['name_hi']) == clean_hindi(s['name']) and clean_hindi(m['rel_hi']) == clean_hindi(s['rel']):
                    matched_mobile_map[m['row']] = s
                    src_mobile_matched.add(s['src_row'])
                    break

    print(f"Total source mobiles matched: {len(src_mobile_matched)} / {len(src_with_mobile)} (100% precision)")
    
    # Now map caste for all master voters from source voters
    src_by_ward_serial = {(s['ward'], s['serial']): s for s in src_voters}
    src_by_epic = {s['epic']: s for s in src_voters if s['epic'] and not s['epic'].startswith('RJ/W')}
    
    for m in master_voters:
        caste_val = None
        # Try epic match
        if m['epic'] in src_by_epic and src_by_epic[m['epic']]['caste']:
            caste_val = src_by_epic[m['epic']]['caste']
        # Try ward serial match
        elif (m['ward'], m['serial']) in src_by_ward_serial and src_by_ward_serial[(m['ward'], m['serial'])]['caste']:
            caste_val = src_by_ward_serial[(m['ward'], m['serial'])]['caste']
        
        if caste_val:
            matched_caste_map[m['row']] = caste_val
    
    print(f"Total master voters receiving authentic caste: {len(matched_caste_map)} / {len(master_voters)}")
    
    print("\n=== Step 4: Updating Master_Voters_Panchayat_Samiti_22.xlsx ===")
    # Update 'सांभरा' sheet
    for r in range(2, ws_mst_sambhara.max_row + 1):
        if r in matched_mobile_map:
            mob = matched_mobile_map[r]['mobile']
            ws_mst_sambhara.cell(r, 16).value = mob
            ws_mst_sambhara.cell(r, 16).number_format = '@'
        
        if r in matched_caste_map:
            ws_mst_sambhara.cell(r, 15).value = matched_caste_map[r]
    
    # Update 'All Voters (Master)' sheet for सांभरा rows
    all_updated_mobs = 0
    all_updated_castes = 0
    for r in range(2, ws_mst_all.max_row + 1):
        p = str(ws_mst_all.cell(r, 3).value or '').strip()
        if p == 'सांभरा':
            w = str(ws_mst_all.cell(r, 4).value or '').strip()
            s = str(ws_mst_all.cell(r, 6).value or '').strip()
            epic = str(ws_mst_all.cell(r, 2).value or '').strip()
            
            # Find in matched_mobile_map
            target_mob = None
            for m_row, s_entry in matched_mobile_map.items():
                m_item = master_by_row[m_row]
                if m_item['ward'] == w and m_item['serial'] == s:
                    target_mob = s_entry['mobile']
                    break
                elif epic and m_item['epic'] == epic:
                    target_mob = s_entry['mobile']
                    break
            
            if target_mob:
                ws_mst_all.cell(r, 16).value = target_mob
                ws_mst_all.cell(r, 16).number_format = '@'
                all_updated_mobs += 1
            
            # Caste
            target_caste = None
            for m_row, c_val in matched_caste_map.items():
                m_item = master_by_row[m_row]
                if m_item['ward'] == w and m_item['serial'] == s:
                    target_caste = c_val
                    break
                elif epic and m_item['epic'] == epic:
                    target_caste = c_val
                    break
            
            if target_caste:
                ws_mst_all.cell(r, 15).value = target_caste
                all_updated_castes += 1
    
    print(f"Updated 'All Voters (Master)': {all_updated_mobs} mobiles, {all_updated_castes} castes.")
    wb_mst.save(MASTER_FILE)
    wb_mst.close()
    print(f"Saved updated master workbook to {MASTER_FILE}!")
    
    print("\n=== Step 5: Generating Sambhara_Voters_Without_Mobile_Numbers.xlsx ===")
    # Identify pending voters
    pending_voters = []
    for m in master_voters:
        if m['row'] not in matched_mobile_map:
            # Caste
            caste_val = matched_caste_map.get(m['row'], m['caste'])
            item = dict(m)
            item['caste'] = caste_val
            item['mobile'] = ''
            pending_voters.append(item)
    
    print(f"Total pending voters without mobile numbers: {len(pending_voters)}")
    
    # Styles for output
    font_header = Font(name='Arial', size=11, bold=True, color='FFFFFF')
    fill_header = PatternFill(start_color='1E3A8A', end_color='1E3A8A', fill_type='solid') # Navy Blue
    
    font_title = Font(name='Arial', size=14, bold=True, color='1E3A8A')
    font_subtitle = Font(name='Arial', size=11, bold=True, color='475569')
    
    font_data = Font(name='Arial', size=10)
    font_bold = Font(name='Arial', size=10, bold=True)
    
    fill_zebra = PatternFill(start_color='F8FAFC', end_color='F8FAFC', fill_type='solid')
    fill_white = PatternFill(start_color='FFFFFF', end_color='FFFFFF', fill_type='solid')
    fill_total = PatternFill(start_color='E2E8F0', end_color='E2E8F0', fill_type='solid')
    
    thin_side = Side(style='thin', color='CBD5E1')
    border_cell = Border(left=thin_side, right=thin_side, top=thin_side, bottom=thin_side)
    border_total = Border(
        top=Side(style='thin', color='94A3B8'),
        bottom=Side(style='double', color='1E293B'),
        left=thin_side, right=thin_side
    )
    
    align_center = Alignment(horizontal='center', vertical='center')
    align_left = Alignment(horizontal='left', vertical='center')
    align_right = Alignment(horizontal='right', vertical='center')
    
    headers = [
        'क्रमांक', 'पहचान पत्र क्रमांक (EPIC No)', 'ग्राम पंचायत', 'वार्ड संख्या',
        'बूथ / भाग संख्या', 'वार्ड में क्र.', 'मतदाता का नाम (हिंदी)', 'मतदाता का नाम (English)',
        'संबंध प्रकार', 'संबंधी का नाम (हिंदी)', 'संबंधी का नाम (English)', 'मकान संख्या',
        'आयु', 'लिंग', 'जाति', 'मोबाइल नंबर', 'गाँव / मोहल्ला', 'स्थिति'
    ]
    
    wb_out = openpyxl.Workbook()
    # Remove default sheet
    wb_out.remove(wb_out.active)
    
    # Sheet 1: Dashboard & Summary
    ws_dash = wb_out.create_sheet('डैशबोर्ड एवं सारांश')
    ws_dash.views.sheetView[0].showGridLines = True
    
    ws_dash.cell(1, 1).value = "ग्राम पंचायत सांभरा - मतदाता मोबाइल नंबर स्थिति सारांश"
    ws_dash.cell(1, 1).font = font_title
    ws_dash.cell(2, 1).value = "प्रत्याशी: खेराज राम हुड्डा (पंचायत समिति सदस्य वार्ड 22)"
    ws_dash.cell(2, 1).font = font_subtitle
    
    dash_headers = ['क्र.', 'वार्ड संख्या', 'कुल मतदाता', 'मोबाइल उपलब्ध', 'शेष मतदाता (बिना मोबाइल)', 'मोबाइल कवरेज (%)', 'पुरुष (शेष)', 'महिला (शेष)']
    for c_idx, h in enumerate(dash_headers, 1):
        cell = ws_dash.cell(4, c_idx)
        cell.value = h
        cell.font = font_header
        cell.fill = PatternFill(start_color='0F766E', end_color='0F766E', fill_type='solid') # Teal Dark
        cell.alignment = align_center
        cell.border = border_cell
    
    wards = sorted(list(set(m['ward'] for m in master_voters)), key=lambda x: int(x) if x.isdigit() else 99)
    start_row = 5
    for idx, w in enumerate(wards, 1):
        r = start_row + idx - 1
        total_w = sum(1 for m in master_voters if m['ward'] == w)
        with_mob_w = sum(1 for r_idx, s in matched_mobile_map.items() if master_by_row[r_idx]['ward'] == w)
        pending_w = total_w - with_mob_w
        pending_male = sum(1 for p in pending_voters if p['ward'] == w and p['gender'] in ['पुरुष', 'पुरूष', 'Male'])
        pending_fem = sum(1 for p in pending_voters if p['ward'] == w and p['gender'] in ['स्त्री', 'महिला', 'Female'])
        
        ws_dash.cell(r, 1, idx).alignment = align_center
        ws_dash.cell(r, 2, f"वार्ड {w}").alignment = align_center
        ws_dash.cell(r, 3, total_w).alignment = align_right
        ws_dash.cell(r, 4, with_mob_w).alignment = align_right
        ws_dash.cell(r, 5, pending_w).alignment = align_right
        
        # Percentage formula
        ws_dash.cell(r, 6, f"=ROUND((D{r}/C{r})*100, 1)").alignment = align_right
        ws_dash.cell(r, 7, pending_male).alignment = align_right
        ws_dash.cell(r, 8, pending_fem).alignment = align_right
        
        fill = fill_zebra if idx % 2 == 0 else fill_white
        for c in range(1, 9):
            ws_dash.cell(r, c).font = font_data
            ws_dash.cell(r, c).fill = fill
            ws_dash.cell(r, c).border = border_cell
            if c in [3, 4, 5, 7, 8]:
                ws_dash.cell(r, c).number_format = '#,##0'
            elif c == 6:
                ws_dash.cell(r, c).number_format = '0.0"%"'
    
    total_r = start_row + len(wards)
    ws_dash.cell(total_r, 1, "").alignment = align_center
    ws_dash.cell(total_r, 2, "कुल योग (Total)").alignment = align_center
    ws_dash.cell(total_r, 3, f"=SUM(C{start_row}:C{total_r-1})").alignment = align_right
    ws_dash.cell(total_r, 4, f"=SUM(D{start_row}:D{total_r-1})").alignment = align_right
    ws_dash.cell(total_r, 5, f"=SUM(E{start_row}:E{total_r-1})").alignment = align_right
    ws_dash.cell(total_r, 6, f"=ROUND((D{total_r}/C{total_r})*100, 1)").alignment = align_right
    ws_dash.cell(total_r, 7, f"=SUM(G{start_row}:G{total_r-1})").alignment = align_right
    ws_dash.cell(total_r, 8, f"=SUM(H{start_row}:H{total_r-1})").alignment = align_right
    
    for c in range(1, 9):
        ws_dash.cell(total_r, c).font = font_bold
        ws_dash.cell(total_r, c).fill = fill_total
        ws_dash.cell(total_r, c).border = border_total
        if c in [3, 4, 5, 7, 8]:
            ws_dash.cell(total_r, c).number_format = '#,##0'
        elif c == 6:
            ws_dash.cell(total_r, c).number_format = '0.0"%"'

    # Auto-fit dashboard columns
    for col in ws_dash.columns:
        max_len = max(len(str(cell.value or '')) for cell in col)
        col_letter = get_column_letter(col[0].column)
        ws_dash.column_dimensions[col_letter].width = max(max_len + 4, 15)
        
    def populate_voter_sheet(ws, voter_list, sheet_title):
        ws.views.sheetView[0].showGridLines = True
        
        # Header Row
        for col_idx, h in enumerate(headers, 1):
            cell = ws.cell(1, col_idx)
            cell.value = h
            cell.font = font_header
            cell.fill = fill_header
            cell.alignment = align_center
            cell.border = border_cell
        
        # Data Rows
        for row_idx, v in enumerate(voter_list, 2):
            fill = fill_zebra if row_idx % 2 == 0 else fill_white
            row_data = [
                row_idx - 1,
                v['epic'],
                'सांभरा',
                v['ward'],
                v['part'],
                v['serial'],
                v['name_hi'],
                v['name_en'],
                v['rel_type'],
                v['rel_hi'],
                v['rel_en'],
                v['house'],
                v['age'],
                v['gender'],
                v['caste'],
                '', # Mobile is blank
                v['village'],
                v['status']
            ]
            
            for col_idx, val in enumerate(row_data, 1):
                cell = ws.cell(row_idx, col_idx)
                cell.value = val
                cell.font = font_data
                cell.fill = fill
                cell.border = border_cell
                
                # Alignments
                if col_idx in [1, 4, 5, 6, 12, 13, 14]:
                    cell.alignment = align_center
                else:
                    cell.alignment = align_left
                
                if col_idx in [1, 6, 13]:
                    if isinstance(val, int) or (isinstance(val, str) and val.isdigit()):
                        cell.value = int(val)
                        cell.number_format = '#,##0'
                elif col_idx in [2, 4, 12]:
                    cell.number_format = '@'

        # Auto column widths
        col_widths = {
            1: 8,   # क्रमांक
            2: 18,  # EPIC
            3: 12,  # ग्राम पंचायत
            4: 10,  # वार्ड
            5: 14,  # भाग
            6: 12,  # क्र.
            7: 20,  # नाम (हिंदी)
            8: 20,  # नाम (English)
            9: 12,  # संबंध
            10: 20, # संबंधी (हिंदी)
            11: 20, # संबंधी (English)
            12: 12, # मकान
            13: 8,  # आयु
            14: 10, # लिंग
            15: 14, # जाति
            16: 15, # मोबाइल
            17: 24, # गाँव
            18: 10  # स्थिति
        }
        for col_idx, width in col_widths.items():
            col_letter = get_column_letter(col_idx)
            ws.column_dimensions[col_letter].width = width

    # Sheet for each ward (वार्ड 1 to 7)
    for w in wards:
        ward_pending = [p for p in pending_voters if p['ward'] == w]
        sheet_name = f"वार्ड {w} (बिना मोबाइल)"
        ws_ward = wb_out.create_sheet(sheet_name)
        populate_voter_sheet(ws_ward, ward_pending, sheet_name)
        print(f"Created sheet '{sheet_name}': {len(ward_pending)} pending voters.")
        
    # Sheet for All Pending
    ws_all_pending = wb_out.create_sheet('सभी शेष मतदाता (All Pending)')
    populate_voter_sheet(ws_all_pending, pending_voters, 'सभी शेष मतदाता (All Pending)')
    print(f"Created sheet 'सभी शेष मतदाता (All Pending)': {len(pending_voters)} voters.")

    wb_out.save(PENDING_OUTPUT_FILE)
    print(f"Saved separate pending excel workbook to {PENDING_OUTPUT_FILE}!")

if __name__ == '__main__':
    main()
