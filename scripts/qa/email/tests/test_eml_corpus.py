#!/usr/bin/env python3
"""
Unit tests for the pure QA seeder core (BACKLOG-1851 / QA-H4).

Run with the Apple system Python:
    /usr/bin/python3 -m unittest discover -s scripts/qa/email/tests
(or `npm run qa:py-test`). No network, no token, no live tenant.
"""

from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timezone
from email.message import EmailMessage

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import eml_corpus as ec  # noqa: E402


def make_eml(
    subject: str,
    from_addr: str,
    to_addr: str = "buyer@example.com",
    date: str = "Fri, 07 Feb 2025 09:00:00 -0800",
    body: str = "Hello about 742 Birchwood Lane NE",
    cc: str | None = None,
) -> bytes:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_addr
    if cc:
        msg["Cc"] = cc
    msg["Date"] = date
    msg.set_content(body)
    return msg.as_bytes()


class TestDateShift(unittest.TestCase):
    def test_shift_months_basic(self):
        dt = datetime(2025, 2, 7, 9, 0, tzinfo=timezone.utc)
        self.assertEqual(ec.shift_months(dt, 12).year, 2026)
        self.assertEqual(ec.shift_months(dt, 12).month, 2)

    def test_shift_months_clamps_short_month(self):
        dt = datetime(2025, 1, 31, 9, 0, tzinfo=timezone.utc)
        shifted = ec.shift_months(dt, 1)  # Feb has no 31st
        self.assertEqual((shifted.month, shifted.day), (2, 28))

    def test_local_shifted_date_pacific(self):
        # 09:00 -0800 on Feb 7 2025 -> Feb 7 2026 local Pacific.
        out = ec.local_shifted_date("Fri, 07 Feb 2025 09:00:00 -0800", 12)
        self.assertEqual(out, "2026-02-07")

    def test_local_shifted_date_utc_boundary_rolls_local_back(self):
        # 20:00 -0800 is 04:00 UTC next day; converting UTC back to Pacific must
        # keep the LOCAL calendar day (the canonical checklist's date).
        out = ec.local_shifted_date("Fri, 14 Feb 2025 20:00:00 -0800", 12)
        self.assertEqual(out, "2026-02-14")


class TestBuildGmailInsert(unittest.TestCase):
    def test_date_header_rewritten_and_roundtrips(self):
        raw = make_eml("742 Birchwood Lane showing today - thoughts?", "sarah@cascaderealty.com")
        built = ec.build_gmail_insert(raw, "TX1_13.eml", 12, None)
        decoded = ec.decode_raw(built["raw"])
        self.assertIn("2026", str(decoded.get("Date")))
        self.assertEqual(
            str(decoded.get("Subject")), "742 Birchwood Lane showing today - thoughts?"
        )

    def test_label_routing_inbox_vs_sent(self):
        inbound = ec.build_gmail_insert(make_eml("s", "tom@pugetsoundinspections.com"), "a.eml", 12, None)
        self.assertEqual(inbound["labelIds"], ["INBOX"])
        outbound = ec.build_gmail_insert(
            make_eml("s", "sarah.mitchell@cascaderealty.com"), "b.eml", 12, None,
            outbound_sender="sarah.mitchell@cascaderealty.com",
        )
        self.assertEqual(outbound["labelIds"], ["SENT"])

    def test_reply_carries_in_reply_to_and_references(self):
        parent_id = ec.synth_message_id("TX1_20.eml")
        built = ec.build_gmail_insert(
            make_eml("Re: 742 Birchwood Lane - ACCEPTED", "david@example.com"),
            "TX1_21.eml", 12, parent_id,
        )
        self.assertTrue(built["isReply"])
        decoded = ec.decode_raw(built["raw"])
        self.assertEqual(str(decoded.get("In-Reply-To")), parent_id)
        self.assertEqual(str(decoded.get("References")), parent_id)

    def test_original_has_no_in_reply_to(self):
        built = ec.build_gmail_insert(make_eml("Original", "a@example.com"), "x.eml", 12, None)
        self.assertFalse(built["isReply"])
        decoded = ec.decode_raw(built["raw"])
        self.assertIsNone(decoded.get("In-Reply-To"))

    def test_synth_message_id_is_deterministic(self):
        self.assertEqual(ec.synth_message_id("TX1_01.eml"), ec.synth_message_id("TX1_01.eml"))
        self.assertNotEqual(ec.synth_message_id("a"), ec.synth_message_id("b"))


class TestSeedPlan(unittest.TestCase):
    def _corpus(self):
        return [
            ("TX1_20_accepted.eml", make_eml("742 Birchwood Lane - ACCEPTED", "sarah.mitchell@cascaderealty.com", date="Sun, 09 Feb 2025 10:00:00 -0800")),
            ("TX1_21_reply.eml", make_eml("Re: 742 Birchwood Lane - ACCEPTED", "david@example.com", date="Sun, 09 Feb 2025 11:00:00 -0800")),
            ("TX1_13_showing.eml", make_eml("742 Birchwood Lane showing today", "sarah.mitchell@cascaderealty.com", date="Fri, 07 Feb 2025 09:00:00 -0800")),
        ]

    def test_plan_is_deterministic_reseed_idempotent(self):
        # Absorbs BACKLOG-1807: wipe -> reseed must reproduce the EXACT same set.
        corpus = self._corpus()
        plan_a = ec.build_seed_plan(corpus, 12)
        plan_b = ec.build_seed_plan(corpus, 12)
        self.assertEqual(plan_a, plan_b)

    def test_thread_order_puts_original_before_reply(self):
        plan = ec.build_seed_plan(self._corpus(), 12)
        subjects = [r["subject"] for r in plan]
        orig = subjects.index("742 Birchwood Lane - ACCEPTED")
        reply = subjects.index("Re: 742 Birchwood Lane - ACCEPTED")
        self.assertLess(orig, reply)

    def test_plan_carries_shifted_dates_and_labels(self):
        plan = ec.build_seed_plan(self._corpus(), 12)
        by_file = {r["file"]: r for r in plan}
        self.assertEqual(by_file["TX1_13_showing.eml"]["shiftedDate"], "2026-02-07")
        self.assertEqual(by_file["TX1_13_showing.eml"]["label"], "SENT")


if __name__ == "__main__":
    unittest.main()
