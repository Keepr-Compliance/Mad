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
        self.assertEqual(classify(["ERROR|c6-apply-twice.sql|psql failed"]), "INVALID")

    def test_zero_checks_is_invalid(self):
        self.assertEqual(classify(["ERROR|c7-rollback.sql|0 checks"]), "INVALID")

    def test_no_lines_is_invalid(self):
        self.assertEqual(classify([]), "INVALID")
        self.assertEqual(classify(["psql:<stdin>:85: ERROR:  null value"]), "INVALID")

    def test_fail_is_killed(self):
        self.assertEqual(classify(["PASS|a|", "FAIL|b|detail"]), "KILLED")

    def test_pass_only_survives(self):
        self.assertEqual(classify(["PASS|a|", "PASS|b|"]), "SURVIVED")


class MigrationPatterns(unittest.TestCase):
    """Every migration edit occurs exactly once in the real migration file."""
    def test_edits_apply_once(self):
        from mutants import MUTANTS
        mig = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "migrations",
                           "20261007200000_backlog_3714_users_column_update_grants.sql")
        src = open(mig).read()
        for name, (edits, _t) in MUTANTS.items():
            for kind, old, _new in edits:
                if kind == "edit":
                    self.assertEqual(src.count(old), 1, f"{name}: {old[:60]!r}")


if __name__ == "__main__":
    unittest.main()
