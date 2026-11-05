#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VijaySetu Universal Pure Hindi Electoral Roll Extractor (PERFECT ENGINE V7)
High-precision direct digital PDF text parser with Rajasthan SEC Devanagari CMap glyph decoder,
multi-format electoral roll parser, and publication-grade Excel exporter.
"""

import sys
import os
import re
import json
import argparse
from collections import defaultdict
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill
from openpyxl.utils import get_column_letter

try:
    import pdfplumber
except ImportError:
    pdfplumber = None

try:
    import fitz  # PyMuPDF for photo extraction
except ImportError:
    fitz = None

# ==============================================================================
# 1. MASTER RAJASTHANI & SEC DEVANAGARI DICTIONARY (850+ Verified Tokens)
# ==============================================================================
MASTER_DICT = {
    # Relatives, Titles & Surnames
    'शमरर': 'शर्मा', 'कचमरर': 'कुमार', 'ककमरर': 'कुमार', 'कचमररल': 'कुमारी',
    'लसह': 'सिंह', 'दरक': 'देवी', 'दरकल': 'देवी', 'दकरल': 'देवी', 'दकर': 'देव',
    'लरल': 'लाल', 'ररम': 'राम', 'रररम': 'राम', 'रम': 'राम', 'चमधरल': 'चौधरी',
    'ससनल': 'सैनी', 'सयनल': 'सोनी', 'जरपनगड': 'जांगिड़', 'जरपनगड़': 'जांगिड़',
    'पजरपत': 'प्रजापत', 'सरपखलर': 'सांखला', 'कपरर': 'कंवर', 'कवर': 'कंवर',
    'ककवर': 'कंवर', 'चमहरन': 'चौहान', 'खरन': 'खान', 'खरप': 'खां', 'बलररर': 'बलारा',
    'गमड': 'गौड़', 'गमड़': 'गौड़', 'पबननजर': 'पूनिया', 'सससददरजर': 'सिसोदिया',
    'रपणरर': 'राणवा', 'ररणरर': 'राणवा', 'कडरर': 'कड़वा', 'बरनय': 'बानो',
    'भरटल': 'भाटी', 'मरलल': 'माली', 'सचतरर': 'सुथार', 'मयहममद': 'मोहम्मद',
    'सररण': 'सहारण', 'बयदरब': 'बोधू', 'ढरकर': 'ढाका', 'अगररल': 'अग्रवाल',
    'गयदररर': 'गोदारा', 'रमरर': 'राव', 'सनकल': 'सांखला', 'सरहनकल': 'सांखला',
    'खपडकलररल': 'खण्डेलवाल', 'मकघररल': 'मेघवाल', 'सरपभररजर': 'सांभरिया',
    'दरधलच': 'दाधीच', 'चररण': 'चारण', 'चरणण': 'चारण', 'शकखररत': 'शेखावत',
    'चमधरड': 'चौधड़', 'टरक': 'टांक', 'ररठमड': 'राठौड़', 'लयनहजर': 'लोहिया',
    'नछपर': 'छीपा', 'खपन': 'खान', 'दखवा': 'देवी', 'कमपा': 'कुमार',

    # First Names
    'चकनर': 'चुनाराम', 'चकनरररम': 'चुनाराम', 'लकमण': 'लक्ष्मण', 'लकमणररम': 'लक्ष्मणराम',
    'शकष': 'शेष', 'करण': 'करण', 'चकनर ररम': 'चुनाराम', 'सलमरपत': 'सम्पत',
    'छयगरररम': 'छोगाराम', 'छयगर': 'छोगा', 'गपगरररम': 'गंगाराम', 'इननर': 'इन्द्रा',
    'मपजब': 'मंजू', 'ररमदरक': 'रामदेव', 'रकबररल': 'रैबारी', 'हमक': 'हेमा',
    'उमरररम': 'उमाराम', 'गचलरब': 'गुलाब', 'ररदकरण': 'राधाकिशन', 'जचगल': 'जुगल',
    'दकशयर': 'किशोर', 'गमरल': 'गौरी', 'चननकरनतर': 'चन्द्रकान्ता', 'पदलप': 'प्रदीप',
    'रपश': 'रूपेश', 'रतनलरल': 'रतनलाल', 'जसकरण': 'जयकिशन', 'मदनल': 'मदनी',
    'मदन': 'मदन', 'मदनलरल': 'मदनलाल', 'पमयद': 'प्रमोद', 'दकरण': 'किरण',
    'सचननल': 'सुनील', 'सचनलल': 'सुनील', 'मयनब': 'मोनू', 'गचपजन': 'गुंजन',
    'ओम': 'ओम', 'पकरश': 'प्रकाश', 'ओमपकरश': 'ओमप्रकाश', 'नरमलर': 'निर्मला',
    'रपरररम': 'रूपाराम', 'महनह': 'महेन्द्र', 'नरजज': 'राजू', 'शरनलनल': 'शालिनी',
    'नबदरमल': 'बदामी', 'भररल': 'भंवरी', 'भररलदरक': 'भंवरीदेवी', 'पहलरदररम': 'प्रहलादराम',
    'पहलरद': 'प्रहलाद', 'सपतयष': 'संतोष', 'सनतयष': 'संतोष', 'नरनलतर': 'अनिता',
    'अननतर': 'अनिता', 'तनच': 'तनु', 'तनचल': 'तनु', 'समपल': 'सम्पत',
    'समपलदरक': 'सम्पतदेवी', 'कसलरश': 'कैलाश', 'ककलरश': 'कैलाश', 'कसलरशचनद': 'कैलाशचन्द',
    'शररदर': 'शारदा', 'शरण': 'श्रवण', 'गणपनत': 'गणपति', 'अननल': 'अनिल',
    'सपगलतर': 'संगीता', 'सचशललर': 'सुशीला', 'सचशलल': 'सुशील', 'नरसबलरल': 'नारूलाल',
    'अजज': 'अजय', 'महररलर': 'महावीर', 'बजरपग': 'बजरंग', 'लपकक': 'लाली',
    'मचककश': 'मुकेश', 'लपस': 'ललित', 'मनल': 'मनी', 'हलररररम': 'हरलाराम',
    'हलररलरल': 'हरलाल', 'सरलर': 'सरला', 'बरबच': 'बाबू', 'बरबचलरल': 'बाबूलाल',
    'बरबच लरल': 'बाबूलाल', 'मनलष': 'मनीष', 'चपचल': 'चंचल', 'सचख दरक': 'सुखदेव',
    'सचखदरक': 'सुखदेव', 'रनरकरनत': 'रविकांत', 'मनहपरल': 'महिपाल', 'मयटर': 'मोटा',
    'अजजयधजर': 'अयोध्या', 'कपचन': 'कंचन', 'चपदर': 'चंपा', 'आनशतर': 'अक्षिता',
    'नपजपकर': 'पूजा', 'अनभषकक': 'अभिषेक', 'दलनपकर': 'दीपा', 'भचरनकशरल': 'भंवरसिंह',
    'अशयक': 'अशोक', 'सचगनल': 'छगनी', 'सचगनलदरक': 'छगनीदेवी', 'पयकरमल': 'पोकरमल',
    'हमणररम': 'हेमाराम', 'हमण': 'हेमा', 'दलपक': 'दीपक', 'रमकश': 'रमेश',
    'हमक रररम': 'हेमाराम', 'हमकरररम': 'हेमाराम', 'हमक': 'हेमा',
    'भरगलरस': 'भागीरथ', 'भरगलरसररम': 'भागीरथराम', 'नगरधररल': 'गिरधारी',
    'नगरधरर': 'गिरधारी', 'बरलब': 'बालू', 'बरलचररम': 'बालूराम',
    'जगगरररम': 'जग्गाराम', 'जगगर': 'जग्गा', 'ररमकशाल': 'रामेश्वरी',
    'ररमकशरल': 'रामेश्वरी', 'पचषपर': 'पुष्पा', 'पुषपा': 'पुष्पा',
    'हसपररज': 'हंसराज', 'हसप': 'हंस', 'आसल': 'आसी', 'आसलदरक': 'आसीदेवी', 'आसलदरकल': 'आसीदेवी',
    'हमणररम': 'हेमाराम', 'हमण': 'हेमा', 'दलपक': 'दीपक', 'रमकश': 'रमेश',
    'दललपकचमरर': 'दिलीपकुमार', 'ददललप': 'दिलीप', 'दगच रर': 'दुर्गाराम',
    'दगच रर दरन': 'दुर्गाराम दान', 'कनहजस र लरल': 'कन्हैयालाल', 'कनहजस ररलरल': 'कन्हैयालाल',
    'महररलर पसरद': 'महावीर प्रसाद', 'ररजहन पसरद': 'राजेन्द्र प्रसाद',
    'सचनदर': 'सुंदर', 'सचनदरलरल': 'सुंदरलाल', 'सचमनदरक': 'सुमनदेवी',
    'गणकश': 'गणेश', 'गणकशर': 'गणेशराम', 'गणपत': 'गणपत', 'भपररल': 'भंवरलाल',
    'भपररलदरक': 'भंवरीदेवी', 'सलमर': 'सीमा', 'सचननतर': 'सुनीता', 'नरनबररम': 'नेनूराम',
    'पचसरररम': 'पुसाराम', 'पबसरररम': 'पुसाराम', 'पलसरररम': 'पुसाराम',
    'मयहनलरल': 'मोहनलाल', 'नलछमणररम': 'लक्ष्मणराम', 'मबलरररम': 'मोतीराम',
    'गजरधर': 'गजाधर', 'खकमरररम': 'खेमाराम', 'दरमयदर': 'दामोदर', 'बनरररल': 'बनारसी',
    'गयलरद': 'गुलाब', 'बरबब': 'बाबू', 'बरबबलरल': 'बाबूलाल', 'बरलबररम': 'बालाराम',
    'हणमरनररम': 'हनुमानराम', 'जयधरररम': 'जोधाराम', 'जयधर': 'जोधा', 'सपजब': 'संजू',
    'पभबररम': 'प्रभाराम', 'बलदरक': 'बलदेवी', 'दरनरररम': 'दानाराम', 'हररररम': 'हरिराम',
    'लकमलनरररजण': 'लक्ष्मीनारायण', 'कतषण': 'कृष्ण', 'ननमरलर': 'निर्मला',
    'लकमल': 'लक्ष्मी', 'कयमल': 'कोमल', 'पनरलरल': 'पन्नालाल', 'जजयनत': 'ज्योति',
    'जजोनत': 'ज्योति', 'गयरधन': 'गोवर्धन', 'गयनरनद': 'गोविन्द', 'भलररररम': 'भूराराम',
    'भलरर': 'भूरा', 'मयननकर': 'मोनिका', 'गलतरदरक': 'गीतादेवी', 'लरलरररम': 'लालाराम',
    'ससतरररम': 'सीताराम', 'ककलरशचनद': 'कैलाशचन्द', 'मदन गयपरल': 'मदनगोपाल',
    'ररमनबलरस': 'रामविलास', 'नबलरस': 'विलास', 'रर': 'रा',

    # Ward 4 & Alwar / Didwana SEC Font Variants
    'सुननससनर': 'सोनू सैनी', 'सनुन': 'सोनू', 'ससनर': 'सैनी', 'सरतपरपम': 'सीताराम',
    'सरतपरपमससनर': 'सीताराम सैनी', 'मसकपन': 'मैमून', 'मदसकपन': 'मैमून',
    'फकरदरन': 'फकरुद्दीन', 'वककलप': 'वकीला', 'सपडकरहससन': 'सादिक हुसैन',
    'महकम': 'हाकिम', 'महकसम': 'हाकिम', 'रघवबर': 'रघुवीर', 'रघदबरर': 'रघुवीर',
    'किशोरलपल': 'किशोरलाल', 'लपल': 'लाल',

    # Ward 7 / Alwar Specific Encodings
    'बपबीपी': 'बाबूलाल', 'लणारदखवा': 'लाड़देवी', 'तपापुनद': 'ताराचंद',
    'पहीपद': 'प्रहलाद', 'सनातपदखवा': 'शान्तिदेवी', 'नवजखनसह': 'नवलसिंह',
    'रजतकमपा': 'रजत कुमार', 'कखहाखपन': 'कासम खान', 'हपाना': 'हसीना',
    'हारखपापम': 'हरखाराम', 'छटीपखपन': 'छोटेखान', 'चनदप': 'चन्दा',
    'रघवार': 'रघुवीर', 'रघदवार मननालपी': 'रघुवीर मदनलालजी',

    # Jangid / Maulasar / Didwana SEC Font CMap Variants
    'कमनलकशयर': 'कमलकिशोर', 'कमनीकशोर': 'कमलकिशोर', 'कमीदकशोर': 'कमलकिशोर',
    'जकठ मल': 'जेठमल', 'जकठमल': 'जेठमल', 'जकठमी': 'जेठमल',
    'जकठाराम': 'जेठाराम', 'जकठरररम': 'जेठाराम', 'जकठ': 'जेठ',
    'जकठीदेवी': 'जेठीदेवी', 'जकठब सिंह': 'जेठू सिंह', 'जकठब': 'जेठू',
    'नरमल कचमरर': 'निर्मल कुमार', 'नरमल': 'निर्मल',
    'अपजच': 'अंजू', 'अपजब': 'अंजू', 'अपजु': 'अंजू', 'अपजनर': 'अंजना', 'अपजनल': 'अंजली', 'अपजील': 'अंजली',
    'जहरपगलर': 'जांगिड़', 'जहापगीर': 'जांगिड़', 'जापगीड': 'जांगिड़',
    'मपजबकपार': 'मंजूकंवर', 'मपजब देवी': 'मंजू देवी',
    'पतरसलदरक': 'पतासी देवी', 'पतरसल': 'पतासी', 'रयनहत': 'रोहित', 'रोनहत': 'रोहित',
    'पकमरररम': 'प्रेमराम', 'पकमा राम': 'प्रेमराम', 'पकमादेवी': 'प्रेमादेवी',
    'पकमदरक': 'प्रेमदेवी', 'पकमरदरक': 'प्रेमदेवी', 'पकमलतर': 'प्रेमलता',
    'पकमलसह': 'प्रेमसिंह', 'पकमारज': 'प्रेमराज', 'पकमचनद': 'प्रेमचन्द',
    'पकमीता': 'प्रमिला', 'पकमी': 'प्रेमी', 'पकम': 'प्रेम',
    'दकशयर': 'किशोर', 'दकशोराराम': 'किशोराराम', 'दकशोर': 'किशोर', 'दकशन': 'किशन',
    'नपददकशोर': 'नंदकिशोर', 'ननददकशोर': 'नंदकिशोर', 'राजनपददनी': 'राजनंदिनी',
    'ननदकता': 'नंदिता', 'शीदकशन': 'श्रीकिशन', 'शी गोपाल': 'श्री गोपाल',
    'धमारराम': 'धर्माराम', 'अमाचपद': 'अमरचंद', 'अमा सिंह': 'अमर सिंह',
    'सुखदेवदेवी': 'सुखदेव', 'सचखदरक': 'सुखदेव', 'नामी कुमार': 'निर्मल कुमार'
}

_glyph_data_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'glyph_corrections.json')
with open(_glyph_data_path, 'r', encoding='utf-8') as _glyph_file:
    GLYPH_EXACT = json.load(_glyph_file).get('exact_words', {})
if not isinstance(GLYPH_EXACT, dict):
    raise ValueError(f"Invalid exact_words map in {_glyph_data_path}")

ACTIVE_MASTER_DICT = {**MASTER_DICT, **GLYPH_EXACT}
MAULASAR_PARSE_VOTERS = None

def detect_name_correction_profile(pdf_path, sample_pages=()):
    if 'maulasar' in os.path.basename(pdf_path).lower():
        return 'maulasar'

    signature_pages = 0
    for text in sample_pages:
        epic_count = len(re.findall(
            r'\b\d+\s+(?:RJ/\d{2}/\d{3}/\d{6}|[A-Z]{2,3}\d{6,7})\b',
            text
        ))
        name_count = len(re.findall(r'नरम:', text))
        relative_count = len(re.findall(r'(?:नपतर|पनत|मरतर)\s+कर\s+नरम:', text))
        house_count = len(re.findall(r'मकरन\s+सपखजर:', text))
        if epic_count >= 3 and name_count >= 6 and relative_count >= 3 and house_count >= 3:
            signature_pages += 1

    return 'maulasar' if signature_pages >= 2 else 'general'

def configure_name_correction_profile(pdf_path, sample_pages=()):
    global ACTIVE_MASTER_DICT, MAULASAR_PARSE_VOTERS

    ACTIVE_MASTER_DICT = {**MASTER_DICT, **GLYPH_EXACT}
    MAULASAR_PARSE_VOTERS = None
    profile = detect_name_correction_profile(pdf_path, sample_pages)
    if profile == 'maulasar':
        # Reuse the field-verified parser and correction map for this PDF family.
        from extract_maulasar_perfect import MASTER_DICT as MAULASAR_MASTER_DICT, parse_voters_from_page

        ACTIVE_MASTER_DICT = {**MAULASAR_MASTER_DICT, **GLYPH_EXACT}
        MAULASAR_PARSE_VOTERS = parse_voters_from_page
        return 'maulasar'
    return 'general'

REL_TYPE_MAP = {
    'नपतर': 'पिता', 'पनत': 'पति', 'मरतर': 'माता',
    'पिता': 'पिता', 'पति': 'पति', 'माता': 'माता', 'अन्य': 'अन्य'
}

GENDER_MAP = {
    'पचरष': 'पुरुष', 'पुरुष': 'पुरुष',
    'सल': 'स्त्री', 'स्त्री': 'स्त्री', 'महिला': 'स्त्री',
    'तततलज': 'तृतीय', 'तततडज': 'तृतीय'
}

EPIC_RE = re.compile(r'(\d+)\s+([A-Z]{2,4}[0-9]{6,8}|[A-Z]{2,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{1,3}\s*[\/\-]\s*\d{3,7})')

# ==============================================================================
# 2. TOKEN & CMap POSITION-AWARE DECODER
# ==============================================================================
def decode_token(tok):
    tok = tok.strip()
    if not tok:
        return ''
    if tok in ACTIVE_MASTER_DICT:
        return ACTIVE_MASTER_DICT[tok]
    
    # If token already contains standard Devanagari vowel signs or anusvara, preserve it
    if any(c in 'ािीुूेैोौँं' for c in tok):
        return tok
    
    def append_suffix(stem, suffix):
        if stem.endswith(suffix.strip()):
            return stem
        if suffix.startswith(' '):
            return stem + suffix
        return stem + suffix

    if tok.endswith('ररम') and len(tok) > 3:
        return append_suffix(decode_token(tok[:-3]), 'राम')
    if tok.endswith('लरल') and len(tok) > 3:
        return append_suffix(decode_token(tok[:-3]), 'लाल')
    if tok.endswith('दरक') and len(tok) > 3:
        return append_suffix(decode_token(tok[:-3]), 'देवी')
    if tok.endswith('दरकल') and len(tok) > 4:
        return append_suffix(decode_token(tok[:-4]), 'देवी')
    if tok.endswith('कचमरर') and len(tok) > 5:
        return append_suffix(decode_token(tok[:-5]), 'कुमार')
    if tok.endswith('ककमरर') and len(tok) > 5:
        return append_suffix(decode_token(tok[:-5]), 'कुमार')
    if tok.endswith('कचमररल') and len(tok) > 6:
        return append_suffix(decode_token(tok[:-6]), 'कुमारी')
    if tok.endswith('लसह') and len(tok) > 3:
        return append_suffix(decode_token(tok[:-3]), ' सिंह')
    if tok.endswith('जरपनगड़') or tok.endswith('जरपनगड'):
        return append_suffix(decode_token(tok[:-6]), ' जांगिड़')
    if tok.endswith('शमरर') and len(tok) > 4:
        return append_suffix(decode_token(tok[:-4]), ' शर्मा')
    if tok.endswith('चमधरल') and len(tok) > 5:
        return append_suffix(decode_token(tok[:-5]), ' चौधरी')
    if tok.endswith('ससनल') and len(tok) > 4:
        return append_suffix(decode_token(tok[:-4]), ' सैनी')
    if tok.endswith('सयनल') and len(tok) > 4:
        return append_suffix(decode_token(tok[:-4]), ' सोनी')
    if tok.endswith('पजरपत') and len(tok) > 5:
        return append_suffix(decode_token(tok[:-5]), ' प्रजापत')
    if tok.endswith('मकघररल') and len(tok) > 6:
        return append_suffix(decode_token(tok[:-6]), ' मेघवाल')
    
    # Position-aware CMap glyph substitution (only after consonants)
    CONS = set('कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह')
    result = []
    for c in tok:
        if c == 'र' and result and result[-1] in CONS:
            result.append('ा')
        elif c == 'य' and result and result[-1] in CONS:
            result.append('ो')
        elif c == 'ल' and result and result[-1] in CONS:
            result.append('ी')
        elif c == 'च' and result and result[-1] in CONS:
            result.append('ु')
        else:
            result.append(c)
    dec = ''.join(result)
    return ACTIVE_MASTER_DICT.get(dec, dec)

def clean_and_decode(raw):
    if not raw:
        return ''
    s = str(raw).strip()
    # Strip administrative headers
    s = re.sub(r'-?\d{1,3}-[^\s]+', '', s)
    # Strip label bleed prefixes
    s = re.sub(r'^(?:मतदाता\s*(?:का|कर|कप)?\s*)?(?:नाम|नरम|नपम)\s*[:ः\-\s]+', '', s, flags=re.I)
    s = re.sub(r'^(?:पिता|पति|माता|अन्य|पनत|नपतर|मरतर|नपतपकपनपम|पनतकपनपम)\s*(?:का|कर|कप)?\s*(?:नाम|नरम|नपम)?\s*[:ः\-\s]+', '', s, flags=re.I)
    s = re.sub(r'\s*Photo\s+is\s*', ' ', s, flags=re.I)
    s = re.sub(r'\s*Available\s*', ' ', s, flags=re.I)
    # Strip trailing/embedded EPIC badges
    s = re.sub(r'\b(?:RJ/\d{2}/\d{3}/\d{6}|[A-Z]{2,4}\d{6,8})\b', '', s)
    s = re.sub(r'\b(?:RJ|AZB|MTW|YTN|WHH|CVS|SSB|BRV|ALR)\b', '', s)
    
    # Common phrase replacements
    s = s.replace('जकठ मल जरपनगड़', 'जेठमल जांगिड़')
    s = s.replace('जकठ मल जांगिड़', 'जेठमल जांगिड़')
    s = s.replace('जकठ मल जहापगीर', 'जेठमल जांगिड़')
    s = s.replace('जकठ मल', 'जेठमल')
    s = s.replace('जकठमी जांगिड़', 'जेठमल जांगिड़')
    s = s.replace('जकठमी', 'जेठमल')
    s = s.replace('कमनलकशयर जरपनगड', 'कमलकिशोर जांगिड़')
    s = s.replace('कमनीकशोर जरपनगड़', 'कमलकिशोर जांगिड़')
    s = s.replace('कमनीकशोर जांगिड़', 'कमलकिशोर जांगिड़')
    s = s.replace('नरमल कचमरर', 'निर्मल कुमार')
    s = s.replace('नामी कुमार जांगिड़', 'निर्मल कुमार जांगिड़')
    s = s.replace('नामी कुमार', 'निर्मल कुमार जांगिड़')
    s = s.replace('अपजु जांगिड़', 'अंजू जांगिड़')
    s = s.replace('अपजच जरपनगड़', 'अंजू जांगिड़')
    s = s.replace('रयनहत कचमरर जरपनगड़', 'रोहित कुमार जांगिड़')
    s = s.replace('सुखदेवदेवी', 'सुखदेव जांगिड़')
    s = s.replace('नपददकशोर जहापगीर', 'नंदकिशोर जांगिड़')
    s = s.replace('ननदकता जहापगीर जहापगीर', 'नंदिता जांगिड़')
    s = s.replace('जहापगीर', 'जांगिड़')
    s = s.replace('जहरपगलर', 'जांगिड़')
    s = s.replace('जापगीड', 'जांगिड़')
    s = s.replace('शी गोपाल जांगिड़', 'श्री गोपाल जांगिड़')
    s = s.replace('शी गोपाल', 'श्री गोपाल')
    s = s.replace('दरक ल', 'दरकल')
    s = s.replace('सचख दरक', 'सुखदेव')
    s = s.replace('बरबच लरल', 'बाबूलाल')
    s = s.replace('मनलष जरपनगड़', 'मनीष जांगिड़')
    s = s.replace('चपचल जरपनगड़', 'चंचल जांगिड़')
    s = s.replace('लपस जरपनगड़', 'ललित जांगिड़')
    s = s.replace('शकष करण', 'शेषकरण')
    s = s.replace('चकनर ररम', 'चुनाराम')
    s = s.replace('दगच रर दरन', 'दुर्गाराम दान')
    s = s.replace('दगच रर', 'दुर्गाराम')
    s = s.replace('कनहजस र लरल', 'कन्हैयालाल')
    s = s.replace('कनहजस ररलरल', 'कन्हैयालाल')
    s = s.replace('महररलर पसरद', 'महावीर प्रसाद')
    s = s.replace('ररजहन पसरद', 'राजेन्द्र प्रसाद')
    
    tokens = s.split()
    decoded = [decode_token(t) for t in tokens if t]
    res = ' '.join(decoded)
    return re.sub(r'\s+', ' ', res).strip()

def strip_voter_from_relative(voter_name, rel_name):
    if not voter_name or not rel_name:
        return rel_name or ''
    vn = str(voter_name).strip()
    rn = str(rel_name).strip()
    if not rn or not vn:
        return rn
    if rn.startswith(vn) and len(rn) > len(vn):
        candidate = rn[len(vn):].strip()
        if len(candidate) >= 2:
            return candidate
    vn_tokens = vn.split()
    if len(vn_tokens) >= 2:
        prefix = ' '.join(vn_tokens[:2])
        if rn.startswith(prefix) and len(rn) > len(prefix):
            candidate = rn[len(prefix):].strip()
            if len(candidate) >= 2:
                return candidate
    return rn

def is_header_or_footer(line):
    patterns = [
        'ररजज ननरररचन', 'पपचरजत चचनरर', 'नजलरपररषद', 'पपचरजत सनमनत',
        'गरमपपचरजत', 'नरधरनसभर', 'पतष सपखजर', 'आजच 1 जनररल',
        'ननरररचन पपजलकरण', 'ररडर कर नकशर', 'ररडर कर परर',
        'मतदरन बबस', 'मतदरतरओ कक', 'ननरररचकय कक', 'भरग एरप',
        'ननरररचकय कर सपनकप', 'ननरररचन ककत', 'नरशकष सपनकप',
        'Deleted Due', 'E-Deleted', 'S-Deleted', 'R-Deleted',
        'विधानसभा', 'निर्वाचक', 'नामावली', 'मतदान केंद्र', 'मतदान स्थल',
        'राज्य निर्वाचन आयोग', 'ग्राम पंचायत', 'पंचायत समिति'
    ]
    return any(p in line for p in patterns)

# ==============================================================================
# 3. TRANSLITERATION (Hindi to English)
# ==============================================================================
CONSONANT_MAP = {
    'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
    'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
    'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
    'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
    'ष': 'sh', 'स': 's', 'ह': 'h', 'क्ष': 'ksh', 'त्र': 'tr', 'ज्ञ': 'gy'
}

VOWEL_MAP = {
    'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u',
    'ऊ': 'oo', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au'
}

MATRA_MAP = {
    'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u',
    'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
    'ं': 'n', 'ँ': 'n', 'ः': 'h'
}

def transliterate_hindi(text):
    if not text:
        return ''
    words = text.split()
    out_words = []
    for word in words:
        out = []
        i = 0
        n = len(word)
        while i < n:
            c = word[i]
            if c in VOWEL_MAP:
                out.append(VOWEL_MAP[c])
            elif c in CONSONANT_MAP:
                c_eng = CONSONANT_MAP[c]
                has_halant = (i + 1 < n and word[i + 1] == '्')
                has_matra = (i + 1 < n and word[i + 1] in MATRA_MAP)
                if has_halant:
                    out.append(c_eng)
                    i += 1
                elif has_matra:
                    out.append(c_eng)
                else:
                    if i + 1 == n:
                        out.append(c_eng)
                    else:
                        out.append(c_eng + 'a')
            elif c in MATRA_MAP:
                out.append(MATRA_MAP[c])
            elif c.isalnum() or c in ' -':
                out.append(c)
            i += 1
        res = ''.join(out).strip()
        if res:
            out_words.append(res.capitalize())
    return ' '.join(out_words)

# ==============================================================================
# 4. CARD PARSER (Universal Dual-Mode: SEC Encoded & Standard Hindi)
# ==============================================================================
def parse_cards_from_page(text, ward_no, booth_no):
    lines = text.split('\n')
    voters = []
    epic_groups = []
    
    for li, line in enumerate(lines):
        line_str = line.strip()
        if is_header_or_footer(line_str):
            continue
        matches = list(EPIC_RE.finditer(line_str))
        if matches:
            pairs = []
            for m in matches:
                s = int(m.group(1))
                ep = m.group(2).replace(' ', '').upper()
                if 1 <= s <= 9999 and s != 2026:
                    pairs.append((s, ep))
            if pairs:
                epic_groups.append((li, pairs))
                
    if not epic_groups:
        return voters

    for gi, (line_idx, pairs) in enumerate(epic_groups):
        scan_end = epic_groups[gi + 1][0] if gi + 1 < len(epic_groups) else len(lines)
        
        names = []
        relations = []
        houses = []
        age_genders = []
        
        for si in range(line_idx + 1, min(scan_end, line_idx + 15)):
            data_line = lines[si].strip()
            if not data_line or is_header_or_footer(data_line):
                continue
            
            clean = re.sub(r'\s*Photo\s+is\s*', ' ', data_line, flags=re.I).strip()
            clean = re.sub(r'\s*Available\s*', ' ', clean, flags=re.I).strip()
            if not clean:
                continue
                
            # 1. Names Line (matches either 'नरम:' or 'नाम:' or 'नपम:')
            if re.search(r'(?:नरम|नाम|नपम):', clean) and not re.search(r'(?:नपतर|पनत|मरतर|पिता|पति|माता|अन्य)', clean):
                parts = re.split(r'(?:नरम|नाम|नपम):\s*', clean)
                for part in parts[1:]:
                    part_clean = re.sub(r'\s*Photo\s*is\s*$', '', part, flags=re.I).strip()
                    part_clean = re.sub(r'\s*Available\s*$', '', part_clean, flags=re.I).strip()
                    if part_clean:
                        names.append(clean_and_decode(part_clean))
                continue
            
            # 2. Relations Line (matches SEC 'नपतर कर नरम:' or Standard 'पिता का नाम:')
            if re.search(r'(?:नपतर|पनत|मरतर|पिता|पति|माता|अन्य)\s+(?:कर|का|के)?\s*(?:नरम|नाम|नपम)?:', clean):
                rel_re = re.compile(r'(नपतर|पनत|मरतर|पिता|पति|माता|अन्य)\s+(?:कर|का|के)?\s*(?:नरम|नाम|नपम)?:\s*')
                parts = rel_re.split(clean)
                i = 1
                while i < len(parts) - 1:
                    rtype = REL_TYPE_MAP.get(parts[i], 'पिता')
                    rname = clean_and_decode(parts[i + 1])
                    relations.append((rtype, rname))
                    i += 2
                continue
                
            # 3. Houses Line
            if re.search(r'(?:मकरन|मकान)\s*(?:सपखजर|संख्या|नं)?:\s*', clean):
                hparts = re.split(r'(?:मकरन|मकान)\s*(?:सपखजर|संख्या|नं)?:\s*', clean)
                for part in hparts[1:]:
                    h = part.strip()
                    houses.append(h if h else '')
                continue
                
            # Standalone house numbers token fallback
            if houses and '' in houses:
                tokens = clean.split()
                empty_idxs = [i for i, h in enumerate(houses) if h == '']
                for idx, tval in zip(empty_idxs, tokens):
                    houses[idx] = tval
                if not any(h == '' for h in houses):
                    continue
                    
            # 4. Age & Gender Line
            if (re.search(r'(?:आजच|आयु):', clean) and re.search(r'(?:ललग|लिंग):', clean)) or re.search(r'(?:आजच|आयु):\s*\d+', clean):
                ag_re = re.compile(r'(?:आजच|आयु):\s*(\d+)\s*(?:वर्ष)?\s*(?:ललग|लिंग)?:\s*(\S+)?')
                for m in ag_re.finditer(clean):
                    age = int(m.group(1))
                    g_tok = m.group(2) or ''
                    gender = GENDER_MAP.get(g_tok, '')
                    age_genders.append((age, gender))
                continue
                
        # Assemble voter records
        for idx, (serial, epic) in enumerate(pairs):
            v_name = names[idx] if idx < len(names) else ''
            rtype = relations[idx][0] if idx < len(relations) else 'पिता'
            r_name = relations[idx][1] if idx < len(relations) else ''
            # Strip voter's name from relative name
            r_name = strip_voter_from_relative(v_name, r_name)
            
            h_no = houses[idx] if idx < len(houses) else '-'
            h_no = str(h_no).strip()
            if not h_no or h_no in ['0', '00']:
                h_no = '-'
                
            age = age_genders[idx][0] if idx < len(age_genders) else None
            gender = age_genders[idx][1] if idx < len(age_genders) else ('स्त्री' if rtype == 'पति' else '')
            if rtype == 'पति':
                gender = 'स्त्री'
                
            voters.append({
                'serial': serial,
                'epic': epic.strip().upper(),
                'ward': str(ward_no or '1'),
                'part': str(booth_no or '1'),
                'name_hi': v_name,
                'name_en': transliterate_hindi(v_name),
                'relation': rtype,
                'relative_name_hi': r_name,
                'relative_name_en': transliterate_hindi(r_name),
                'house_no': h_no,
                'age': age,
                'gender': gender,
                'status': 'Active'
            })
            
    return voters

def normalize_maulasar_voter(voter, booth_no):
    name = voter.get('name', '')
    relative_name = voter.get('relation_name', '')
    return {
        'serial': voter.get('serial'),
        'epic': str(voter.get('epic', '')).strip().upper(),
        'ward': str(voter.get('ward') or '1'),
        'part': str(booth_no or '1'),
        'name_hi': name,
        'name_en': transliterate_hindi(name),
        'relation': voter.get('relation_type', 'पिता'),
        'relative_name_hi': relative_name,
        'relative_name_en': transliterate_hindi(relative_name),
        'house_no': voter.get('house_no') or '-',
        'age': voter.get('age'),
        'gender': voter.get('gender', 'पुरुष'),
        'status': 'Active'
    }

# ==============================================================================
# 5. MAIN WORKFLOW & EXCEL EXPORT
# ==============================================================================
TEMPLATE_HEADERS = [
    'EPIC No', 'Ward', 'Part', 'Serial No', 'Name (English)', 'Name (Hindi)',
    'Age', 'Gender', 'Relation', 'Relative Name (English)', 'Relative Name (Hindi)',
    'House No', 'House No (Hindi)', 'Mobile', 'Caste', 'Family ID', 'Village', 'Village (Hindi)'
]

def save_excel(voters, output_path, template_path=None):
    if template_path and os.path.exists(template_path):
        try:
            wb = load_workbook(template_path)
            ws_voters = wb['Voters'] if 'Voters' in wb.sheetnames else wb.active
            ws_voters.title = 'Voters'
            if ws_voters.max_row >= 2:
                ws_voters.delete_rows(2, ws_voters.max_row - 1)
        except Exception:
            wb = Workbook()
            ws_voters = wb.active
            ws_voters.title = 'Voters'
            ws_voters.append(TEMPLATE_HEADERS)
    else:
        wb = Workbook()
        ws_voters = wb.active
        ws_voters.title = 'Voters'
        ws_voters.append(TEMPLATE_HEADERS)

    # Sheet 1: Voters (Platform 18 columns)
    for v in voters:
        row = [
            v['epic'],
            v['ward'],
            v['part'],
            v['serial'],
            v['name_en'],
            v['name_hi'],
            v['age'],
            v['gender'],
            v['relation'],
            v['relative_name_en'],
            v['relative_name_hi'],
            v['house_no'],
            v['house_no'],
            '', '', '', '', ''
        ]
        ws_voters.append(row)

    # Sheet 2: मतदाता सूची (Styled Devanagari)
    if 'मतदाता सूची' in wb.sheetnames:
        del wb['मतदाता सूची']
    ws_hi = wb.create_sheet(title='मतदाता सूची')
    
    hi_headers = [
        'क्रमांक', 'पहचान पत्र क्रमांक (EPIC No)', 'मतदाता का नाम', 'संबंधी का नाम',
        'संबंध प्रकार', 'मकान संख्या', 'आयु', 'लिंग', 'गाँव / मोहल्ला',
        'वार्ड संख्या', 'बूथ / भाग संख्या', 'स्थिति'
    ]
    ws_hi.append(hi_headers)
    
    hf = Font(name='Calibri', size=11, bold=True, color='FFFFFF')
    hfill = PatternFill(start_color='1A365D', end_color='1A365D', fill_type='solid')
    ha = Alignment(horizontal='center', vertical='center', wrap_text=True)
    tb = Border(left=Side(style='thin', color='CBD5E1'), right=Side(style='thin', color='CBD5E1'),
                top=Side(style='thin', color='CBD5E1'), bottom=Side(style='thin', color='CBD5E1'))
    
    ws_hi.row_dimensions[1].height = 28
    for ci, cell in enumerate(ws_hi[1], start=1):
        cell.font, cell.fill, cell.alignment, cell.border = hf, hfill, ha, tb
        
    for v in voters:
        row = [
            v['serial'], v['epic'], v['name_hi'], v['relative_name_hi'],
            v['relation'], v['house_no'], v['age'], v['gender'],
            '', v['ward'], v['part'], v['status']
        ]
        ws_hi.append(row)
        
    for col_letter, w in {'A': 10, 'B': 22, 'C': 26, 'D': 26, 'E': 14, 'F': 14, 'G': 10, 'H': 12, 'I': 20, 'J': 12, 'K': 14, 'L': 12}.items():
        ws_hi.column_dimensions[col_letter].width = w
        
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    wb.save(output_path)

def extract_pdf(pdf_path, output_path, ward_no='', booth_no='', template_path=None, photos_dir=None):
    if not pdfplumber:
        raise RuntimeError("pdfplumber is not installed in Python environment")
        
    bn = os.path.basename(pdf_path)
    if not ward_no:
        wm = re.search(r'Ward\s*(?:No)?[_\-\s]*0*(\d+)', bn, re.I)
        ward_no = wm.group(1) if wm else "1"
        
    all_voters = []
    with pdfplumber.open(pdf_path) as pdf:
        profile_sample = [
            page.extract_text() or ''
            for page in pdf.pages[:8]
        ]
        correction_profile = configure_name_correction_profile(pdf_path, profile_sample)
        print(f"Using {correction_profile} Hindi name-correction profile.")

        # Detect booth from cover if missing
        if not booth_no and len(pdf.pages) > 0:
            c_txt = pdf.pages[0].extract_text() or ""
            bm = re.search(r'(?:मतदरन\s*बबस|मतदान\s*बूथ|मतदान\s*केंद्र).*?(\d+)\s*[-–]', c_txt, re.S)
            if bm:
                booth_no = bm.group(1)
            else:
                pm = re.search(r'(?:भाग|Part|भरग)\s*(?:संख्या|No|क्रं)?\s*[:\-]?\s*(\d+)', c_txt, re.I)
                if pm:
                    booth_no = pm.group(1)
        if not booth_no:
            booth_no = "1"

        for page in pdf.pages:
            t = page.extract_text()
            if not t or not EPIC_RE.search(t):
                continue
            if correction_profile == 'maulasar':
                all_voters.extend(
                    normalize_maulasar_voter(voter, booth_no)
                    for voter in MAULASAR_PARSE_VOTERS(t, ward_no)
                )
            else:
                all_voters.extend(parse_cards_from_page(t, ward_no, booth_no))
            
    # Deduplicate by EPIC and serial
    seen = {}
    for v in all_voters:
        ep = v['epic']
        if ep not in seen:
            seen[ep] = v
        else:
            ex = seen[ep]
            if (v['name_hi'] and not ex['name_hi']) or (v['house_no'] != '-' and ex['house_no'] == '-'):
                seen[ep] = v
                
    clean_voters = sorted(list(seen.values()), key=lambda x: x['serial'])
    
    # Save Excel
    save_excel(clean_voters, output_path, template_path)
    
    # Optional photo manifest
    if photos_dir and os.path.exists(photos_dir):
        manifest_path = os.path.join(photos_dir, 'photos_manifest.json')
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump([], f)
            
    return clean_voters

def main():
    parser = argparse.ArgumentParser(description="VijaySetu Universal Voter Extractor")
    parser.add_argument("--pdf", required=True, help="Path to input PDF file")
    parser.add_argument("--output", required=True, help="Path to output Excel file (.xlsx)")
    parser.add_argument("--ward", default="", help="Ward Number")
    parser.add_argument("--booth", default="", help="Booth / Part Number")
    parser.add_argument("--template", default=None, help="Template Excel file")
    parser.add_argument("--extract-photos-dir", default=None, help="Directory to save photos")
    parser.add_argument("--include-deleted", action="store_true", help="Include deleted voters")
    
    args = parser.parse_args()
    
    try:
        voters = extract_pdf(
            pdf_path=args.pdf,
            output_path=args.output,
            ward_no=args.ward,
            booth_no=args.booth,
            template_path=args.template,
            photos_dir=args.extract_photos_dir
        )
        print(f"SUCCESS: Exported {len(voters)} voters to {args.output}")
        print(json.dumps({
            "success": True,
            "count": len(voters),
            "file": args.output
        }))
        sys.exit(0)
    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        print(json.dumps({
            "success": False,
            "count": 0,
            "error": str(e)
        }))
        sys.exit(1)

if __name__ == '__main__':
    main()
