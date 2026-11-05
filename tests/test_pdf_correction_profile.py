"""Regression tests for PDF-specific Hindi correction profiles."""

import os
import sys
import unittest
from types import SimpleNamespace


BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT_DIR = os.path.join(BACKEND_DIR, "scripts")
sys.path.insert(0, SCRIPT_DIR)

import extract_voters_perfect as extractor
import extract_maulasar_perfect as maulasar_extractor


class PdfCorrectionProfileTests(unittest.TestCase):
    def tearDown(self):
        extractor.configure_name_correction_profile("Ward No-001.pdf")

    def test_maulasar_pdf_uses_verified_regional_dictionary(self):
        profile = extractor.configure_name_correction_profile(
            "172345-MAULASAR-Ward No-001.pdf"
        )
        regional_only = next(
            (key, value)
            for key, value in maulasar_extractor.MASTER_DICT.items()
            if key not in extractor.MASTER_DICT and " " not in key
        )

        self.assertEqual(profile, "maulasar")
        self.assertIs(
            extractor.MAULASAR_PARSE_VOTERS,
            maulasar_extractor.parse_voters_from_page,
        )
        self.assertEqual(extractor.decode_token(regional_only[0]), regional_only[1])

    def test_renamed_pdf_uses_structural_signature(self):
        page = "\n".join(
            [
                f"{serial} ABC{serial:07d}"
                for serial in range(1, 4)
            ] + [
                "नरम: उदाहरण",
                "नरम: नमूना",
                "नरम: पाठ",
                "नरम: परीक्षण",
                "नरम: दस्तावेज",
                "नरम: सही",
                "नपतर कर नरम: व्यक्ति",
                "पनत कर नरम: व्यक्ति",
                "मरतर कर नरम: व्यक्ति",
                "मकरन सपखजर: 1",
                "मकरन सपखजर: 2",
                "मकरन सपखजर: 3",
            ]
        )
        sample_pages = [page, page]

        self.assertEqual(
            extractor.detect_name_correction_profile(
                "renamed-upload.pdf", sample_pages
            ),
            "maulasar",
        )
        self.assertEqual(
            extractor.configure_name_correction_profile(
                "renamed-upload.pdf", sample_pages
            ),
            "maulasar",
        )

    def test_generic_pdf_does_not_match_one_weak_signature_page(self):
        page = "\n".join([
            "1 ABC1234567",
            "नरम: उदाहरण",
            "नपतर कर नरम: व्यक्ति",
            "मकरन सपखजर: 1",
        ])

        self.assertEqual(
            extractor.detect_name_correction_profile("other.pdf", [page]),
            "general",
        )

    def test_other_pdf_keeps_general_dictionary_and_shared_glyph_fixes(self):
        profile = extractor.configure_name_correction_profile("Ward No-001.pdf")

        self.assertEqual(profile, "general")
        self.assertEqual(
            extractor.decode_token("फिरपज"),
            extractor.GLYPH_EXACT["फिरपज"],
        )
        self.assertEqual(
            extractor.ACTIVE_MASTER_DICT,
            {**extractor.MASTER_DICT, **extractor.GLYPH_EXACT},
        )

    def test_maulasar_records_adapt_to_export_schema(self):
        record = extractor.normalize_maulasar_voter(
            {
                "serial": 12,
                "epic": "abc1234567",
                "ward": "4",
                "name": "उदाहरण",
                "relation_type": "पिता",
                "relation_name": "परीक्षण",
                "house_no": "17",
                "age": 42,
                "gender": "पुरुष",
            },
            "8",
        )

        self.assertEqual(record["serial"], 12)
        self.assertEqual(record["epic"], "ABC1234567")
        self.assertEqual(record["ward"], "4")
        self.assertEqual(record["part"], "8")
        self.assertEqual(record["name_hi"], "उदाहरण")
        self.assertEqual(record["relative_name_hi"], "परीक्षण")
        self.assertEqual(record["house_no"], "17")
        self.assertEqual(record["age"], 42)

    def test_missing_age_and_gender_are_not_guessed(self):
        page = "1 RJ/08/061/459531"
        regional_record = maulasar_extractor.parse_voters_from_page(page, "13")[0]
        generic_record = extractor.parse_cards_from_page(page, "13", "1")[0]

        for record in (regional_record, generic_record):
            self.assertIsNone(record["age"])
            self.assertEqual(record["gender"], "")

    def test_coordinate_crops_keep_two_adjacent_voters_separate(self):
        anchors = [
            {"text": "ABC1234567", "x0": 72, "x1": 125, "top": 100},
            {"text": "ABC1234568", "x0": 245, "x1": 298, "top": 100},
        ]
        words = [
            {"text": "1", "x0": 50, "x1": 56, "top": 100},
            {"text": "2", "x0": 223, "x1": 229, "top": 100},
            {"text": "नाम:", "x0": 92, "x1": 108, "top": 114},
            {"text": "नाम:", "x0": 265, "x1": 281, "top": 114},
        ]
        words.extend(anchors)

        class FakePage:
            width = 595
            height = 800

            def extract_words(self):
                return words

            def crop(self, box):
                card_text = (
                    "1 ABC1234567\nनाम: पहला नाम\nपिता का नाम: पिता एक\n"
                    "मकान संख्या: 12\nआयु: 45 लिंग: पुरुष"
                    if box[0] < 200
                    else "2 ABC1234568\nनाम: दूसरा नाम\nपिता का नाम: पिता दो\n"
                    "मकान संख्या: 14\nआयु: 52 लिंग: स्त्री"
                )
                return SimpleNamespace(extract_text=lambda **_kwargs: card_text)

        records = extractor.parse_voters_from_page_coordinates(
            FakePage(),
            "13",
            "1",
            "general",
            [],
            "unicode",
        )

        self.assertEqual([record["name_hi"] for record in records], ["पहला नाम", "दूसरा नाम"])
        self.assertEqual(
            [record["relative_name_hi"] for record in records],
            ["एक", "दो"],
        )

    def test_krutidev_font_is_converted_before_field_parsing(self):
        font_names = ["ABCDEF+KrutiDev010"]
        raw_text = "1 ABC1234567\nuke: jke\nfirk: lqjsUnz\nvk;q: 45 fyax: iq#k"
        converted = extractor.convert_legacy_pdf_text(raw_text, font_names)
        record = extractor.parse_cards_from_page(
            converted,
            "13",
            "1",
            legacy_unicode=True,
        )[0]

        self.assertIn("ABC1234567", converted)
        self.assertIn("नाम:", converted)
        self.assertEqual(record["name_hi"], "राम")
        self.assertEqual(record["relative_name_hi"], "सुरेन्द्र")
        self.assertEqual(record["age"], 45)

    def test_coordinate_crops_convert_legacy_font_fields(self):
        words = [
            {"text": "1", "x0": 50, "x1": 56, "top": 100},
            {"text": "ABC1234567", "x0": 72, "x1": 125, "top": 100},
            {"text": "uke:", "x0": 92, "x1": 110, "top": 114},
        ]

        class FakePage:
            width = 595
            height = 800

            def extract_words(self):
                return words

            def crop(self, _box):
                card_text = "1 ABC1234567\nuke: jke\nfirk: lqjsUnz\nvk;q: 45 fyax: iq#k"
                return SimpleNamespace(extract_text=lambda **_kwargs: card_text)

        records = extractor.parse_voters_from_page_coordinates(
            FakePage(),
            "13",
            "1",
            "general",
            ["ABCDEF+KrutiDev010"],
            "krutidev",
        )

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["name_hi"], "राम")
        self.assertEqual(records[0]["relative_name_hi"], "सुरेन्द्र")
        self.assertEqual(records[0]["age"], 45)


if __name__ == "__main__":
    unittest.main()
