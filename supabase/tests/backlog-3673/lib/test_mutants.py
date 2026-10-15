#!/usr/bin/env python3
"""Unit check of the mutant verdict. Run: python3 lib/test_mutants.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mutants import classify  # noqa: E402


class Classify(unittest.TestCase):
    def test_error_is_invalid_even_with_fail(self):
        self.assertEqual(classify(["FAIL|d4 x|", "ERROR|c3-authenticated.sql|psql failed"]), "INVALID")

    def test_error_only_is_invalid(self):
        self.assertEqual(classify(["ERROR|c4-apply-twice.sql|psql failed"]), "INVALID")

    def test_zero_checks_is_invalid(self):
        self.assertEqual(classify(["ERROR|c5a-rollback.sql|0 checks"]), "INVALID")

    def test_no_lines_is_invalid(self):
        self.assertEqual(classify([]), "INVALID")
        self.assertEqual(classify(["psql:<stdin>:85: ERROR:  null value"]), "INVALID")

    def test_fail_is_killed(self):
        self.assertEqual(classify(["PASS|a|", "FAIL|b|detail"]), "KILLED")

    def test_pass_only_survives(self):
        self.assertEqual(classify(["PASS|a|", "PASS|b|"]), "SURVIVED")


if __name__ == "__main__":
    unittest.main()
