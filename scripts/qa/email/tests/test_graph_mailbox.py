#!/usr/bin/env python3
"""
Unit tests for the recursive Graph wipe core (BACKLOG-1851 / QA-H4).

Exercises the folder recursion, the two-way emptiness verification
(all folders + $search == 0), and the destructive-op guard against MOCKED Graph
responses — no token, no live mailbox (SR ruling: a dry-run that only prints a
command proves nothing).

    /usr/bin/python3 -m unittest discover -s scripts/qa/email/tests
"""

from __future__ import annotations

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import graph_mailbox as gm  # noqa: E402


class FakeGraph:
    """A stateful in-memory Graph mock keyed by URL shape."""

    def __init__(self, owner="agent@izzyrescue.org", page_size=1000):
        self.owner = owner
        self.page_size = page_size
        # folder_id -> {"displayName", "children": [ids], "messages": [ids]}
        self.folders: dict[str, dict] = {}
        self.top: list[str] = []
        self.deleted: list[str] = []

    def add_folder(self, fid, name, parent=None):
        self.folders[fid] = {"displayName": name, "children": [], "messages": []}
        if parent:
            self.folders[parent]["children"].append(fid)
        else:
            self.top.append(fid)
        return fid

    def add_messages(self, fid, ids):
        self.folders[fid]["messages"].extend(ids)

    def _all_remaining(self) -> list[str]:
        out: list[str] = []
        for f in self.folders.values():
            out.extend(f["messages"])
        return out

    def _page(self, full_items, offset, key, base_url):
        page = full_items[offset : offset + self.page_size]
        next_offset = offset + self.page_size
        body = {
            "value": [
                {"id": i, "displayName": i} if key == "folders" else {"id": i} for i in page
            ]
        }
        if next_offset < len(full_items):
            body["@odata.nextLink"] = f"{base_url}||offset={next_offset}"
        return body

    # http_fn(method, url, body=None)
    def __call__(self, method, url, body=None):
        if method == "DELETE":
            m = re.search(r"/me/messages/([^/?]+)$", url)
            mid = m.group(1)
            for f in self.folders.values():
                if mid in f["messages"]:
                    f["messages"].remove(mid)
            self.deleted.append(mid)
            return None

        # nextLink continuation
        if "||offset=" in url:
            base, off = url.split("||offset=")
            offset = int(off)
            return self._continue(base, offset)

        if re.search(r"/me\?", url):
            return {"mail": self.owner, "userPrincipalName": self.owner}

        return self._continue(url, 0)

    def _continue(self, url, offset):
        # childFolders
        m = re.search(r"/me/mailFolders/([^/]+)/childFolders", url)
        if m:
            return self._page(self.folders[m.group(1)]["children"], offset, "folders", url)
        # messages in a folder
        m = re.search(r"/me/mailFolders/([^/]+)/messages", url)
        if m:
            return self._page(self.folders[m.group(1)]["messages"], offset, "messages", url)
        # top-level folders
        if re.search(r"/me/mailFolders\?", url):
            return self._page(self.top, offset, "folders", url)
        # $search index probe
        if re.search(r"/me/messages\?\$search", url):
            return self._page(self._all_remaining(), offset, "messages", url)
        raise AssertionError(f"unrouted URL: {url}")


class TestGuard(unittest.TestCase):
    def test_refuses_without_owner(self):
        ok, reason = gm.check_wipe_allowed("", "x@y.com")
        self.assertFalse(ok)
        self.assertIn("owner", reason)

    def test_refuses_without_confirm(self):
        ok, _ = gm.check_wipe_allowed("agent@izzyrescue.org", None)
        self.assertFalse(ok)

    def test_refuses_confirm_mismatch(self):
        ok, reason = gm.check_wipe_allowed("agent@izzyrescue.org", "someone@else.com")
        self.assertFalse(ok)
        self.assertIn("does not match", reason)

    def test_refuses_non_allowlisted(self):
        ok, reason = gm.check_wipe_allowed("ceo@production.com", "ceo@production.com")
        self.assertFalse(ok)
        self.assertIn("allowlist", reason)

    def test_allows_confirmed_allowlisted(self):
        ok, _ = gm.check_wipe_allowed("agent@izzyrescue.org", "Agent@izzyrescue.org")
        self.assertTrue(ok)


class TestRecursion(unittest.TestCase):
    def _mailbox(self, page_size=1000):
        g = FakeGraph(page_size=page_size)
        g.add_folder("inbox", "Inbox")
        g.add_folder("sent", "Sent Items")
        g.add_folder("archive", "Archive")
        g.add_folder("archive-2024", "2024", parent="archive")  # nested
        g.add_messages("inbox", ["m1", "m2"])
        g.add_messages("sent", ["m3"])
        g.add_messages("archive-2024", ["m4"])  # would be MISSED by a 4-folder wipe
        return g

    def test_walk_folders_recurses_nested(self):
        g = self._mailbox()
        ids = {f["id"] for f in gm.walk_folders(g)}
        self.assertEqual(ids, {"inbox", "sent", "archive", "archive-2024"})

    def test_wipe_deletes_every_folder_including_nested(self):
        g = self._mailbox()
        stats = gm.wipe_all_folders(g)
        self.assertEqual(stats["deleted"], 4)  # incl. the nested m4
        self.assertEqual(stats["remaining"], 0)
        self.assertEqual(stats["searchRemaining"], 0)
        self.assertTrue(stats["verified"])

    def test_wipe_paginates(self):
        g = self._mailbox(page_size=1)  # force nextLink loops
        stats = gm.wipe_all_folders(g)
        self.assertEqual(stats["deleted"], 4)
        self.assertTrue(stats["verified"])

    def test_verify_fails_if_search_index_lags(self):
        # Ghost scenario: after deletes the folders enumerate empty, but the
        # $search index still returns a stale row — verification must FAIL.
        g = self._mailbox()
        orig_all = g._all_remaining

        def all_remaining():
            base = orig_all()
            return base if base else ["ghost"]  # phantom row once folders empty

        g._all_remaining = all_remaining  # type: ignore
        stats = gm.wipe_all_folders(g)
        self.assertEqual(stats["remaining"], 0)
        self.assertEqual(stats["searchRemaining"], 1)
        self.assertFalse(stats["verified"])

    def test_dry_run_deletes_nothing(self):
        g = self._mailbox()
        stats = gm.wipe_all_folders(g, dry_run=True)
        self.assertEqual(g.deleted, [])
        self.assertEqual(stats["deleted"], 4)  # counted, not performed
        self.assertFalse(stats["verified"])  # dry-run never certifies


if __name__ == "__main__":
    unittest.main()
