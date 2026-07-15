import unittest

from mtproto.mention_rules import clean_terms, first_matching_term, fold_text, source_is_excluded


class MentionRuleTests(unittest.TestCase):
    def test_diacritics_and_case_fold_to_the_same_latin_form(self):
        self.assertEqual(fold_text("NŌTEM nótem"), "notem notem")
        self.assertEqual(first_matching_term("Обзор NÓTEM", ["notem"]), "notem")

    def test_accent_variants_remain_separate_telegram_queries(self):
        self.assertEqual(clean_terms(["Notem", "notem", "nōtem", "nótem"], 12),
                         ["Notem", "nōtem", "nótem"])

    def test_latin_and_cyrillic_remain_distinct(self):
        self.assertIsNone(first_matching_term("бренд нотем", ["notem"]))
        self.assertEqual(first_matching_term("бренд нотем", ["нотем"]), "нотем")

    def test_any_include_matches_and_any_exclude_overrides(self):
        self.assertEqual(first_matching_term("Запуск второго бренда", ["первый", "второго"]), "второго")
        self.assertIsNone(first_matching_term("Запуск бренда, но это реклама", ["бренда"], ["реклама"]))

    def test_word_mode_uses_unicode_boundaries_and_flexible_phrase_spaces(self):
        self.assertIsNone(first_matching_term("noteworthy", ["note"], match_mode="word"))
        self.assertEqual(first_matching_term("Это note!", ["note"], match_mode="word"), "note")
        self.assertEqual(first_matching_term("мой\nбренд", ["мой бренд"], match_mode="word"), "мой бренд")
        self.assertIsNone(first_matching_term("супербренд", ["бренд"], match_mode="word"))

    def test_source_exclusions_accept_username_and_numeric_channel_id(self):
        self.assertTrue(source_is_excluded("ByNotem", 123, ["@bynotem"], []))
        self.assertTrue(source_is_excluded(None, "456", [], [456]))
        self.assertTrue(source_is_excluded(None, 789, ["789"], []))
        self.assertFalse(source_is_excluded("other", 321, ["bynotem"], [456]))


if __name__ == "__main__":
    unittest.main()
