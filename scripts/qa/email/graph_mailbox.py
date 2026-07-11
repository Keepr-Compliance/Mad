#!/usr/bin/env python3
"""
Graph mailbox recursion + wipe-verification core for the QA harness
(BACKLOG-1851 / QA-H4).

PURE logic with an INJECTABLE http function — no token load, no urllib here — so
the recursion / `$search == 0` / destructive-op-guard logic is exercised by
`tests/test_graph_mailbox.py` against mocked Graph responses. The thin CLI
(`wipe-mailbox-recursive.py`) supplies the real HTTP + token.

Why this exists: `seed-m365.py` only wipes 4 well-known folders
(inbox/sentitems/drafts/deleteditems). The v2.20.0 ceremony needs a recursive
wipe across ALL mail folders + a `$search` index probe returning 0, so a
reseed reproduces EXACTLY 190/69/37 with 0 ghosts (absorbs BACKLOG-1807).

DESTRUCTIVE-OP GUARD (SR ruling, BACKLOG-1851): a recursive all-folders delete
MUST refuse unless the token's mailbox owner is on the QA allowlist AND the
operator confirms that exact address. This makes an accidental production wipe
structurally impossible.
"""

from __future__ import annotations

from typing import Callable, Optional

GRAPH = "https://graph.microsoft.com/v1.0"

# Mailboxes this tool is EVER allowed to recursively empty. QA demo only.
DEFAULT_QA_ALLOWLIST = frozenset({"agent@izzyrescue.org"})

# A broad index probe: after a full wipe, a $search over common vowels must
# return 0 — proving the search index (not just folder enumeration) is empty.
SEARCH_PROBE_TERM = '"a" OR "e" OR "i" OR "o" OR "u"'

# http_fn(method, url, body=None) -> parsed-json dict | None
HttpFn = Callable[..., Optional[dict]]


# ---------------------------------------------------------------------------
# Destructive-op guard (PURE)
# ---------------------------------------------------------------------------

def check_wipe_allowed(
    owner_addr: Optional[str],
    confirm_addr: Optional[str],
    allowlist=DEFAULT_QA_ALLOWLIST,
) -> tuple[bool, str]:
    """
    Decide whether a recursive wipe of `owner_addr`'s mailbox is permitted.

    Requires ALL of: a resolved owner; an operator `--confirm-mailbox` that
    matches it exactly (case-insensitive); and the owner on the QA allowlist.
    Returns (allowed, reason).
    """
    owner = (owner_addr or "").strip().lower()
    confirm = (confirm_addr or "").strip().lower()
    allow = {a.strip().lower() for a in allowlist}

    if not owner:
        return False, "could not resolve the mailbox owner (GET /me) — refusing to wipe"
    if not confirm:
        return False, (
            f"refusing to wipe {owner}: pass --confirm-mailbox {owner} to acknowledge "
            f"the destructive recursive delete"
        )
    if confirm != owner:
        return False, (
            f"--confirm-mailbox ({confirm}) does not match the token's mailbox owner "
            f"({owner}) — refusing to wipe"
        )
    if owner not in allow:
        return False, (
            f"{owner} is not on the QA wipe allowlist {sorted(allow)} — refusing to wipe a "
            f"non-QA mailbox"
        )
    return True, f"authorized: {owner} is an allowlisted QA mailbox and was confirmed"


# ---------------------------------------------------------------------------
# Owner resolution
# ---------------------------------------------------------------------------

def get_mailbox_owner(http_fn: HttpFn) -> str:
    """Resolve the token's mailbox address via GET /me."""
    data = http_fn("GET", f"{GRAPH}/me?$select=mail,userPrincipalName") or {}
    return (data.get("mail") or data.get("userPrincipalName") or "").strip()


# ---------------------------------------------------------------------------
# Recursive folder walk
# ---------------------------------------------------------------------------

def walk_folders(http_fn: HttpFn) -> list[dict]:
    """
    Return ALL mail folders (id, displayName) recursively, including nested
    childFolders — not just the 4 well-known ones.
    """
    out: list[dict] = []

    def _collect(url: str) -> list[dict]:
        folders: list[dict] = []
        while url:
            data = http_fn("GET", url) or {}
            for f in data.get("value", []):
                folders.append({"id": f["id"], "displayName": f.get("displayName", "")})
            url = data.get("@odata.nextLink") or ""
        return folders

    top = _collect(f"{GRAPH}/me/mailFolders?$top=100&$select=id,displayName")
    stack = list(top)
    out.extend(top)
    while stack:
        folder = stack.pop()
        children = _collect(
            f"{GRAPH}/me/mailFolders/{folder['id']}/childFolders?$top=100&$select=id,displayName"
        )
        out.extend(children)
        stack.extend(children)
    return out


def list_message_ids(http_fn: HttpFn, folder_id: str) -> list[str]:
    """All message ids in a folder, following pagination."""
    ids: list[str] = []
    url = f"{GRAPH}/me/mailFolders/{folder_id}/messages?$top=100&$select=id"
    while url:
        data = http_fn("GET", url) or {}
        ids.extend(m["id"] for m in data.get("value", []))
        url = data.get("@odata.nextLink") or ""
    return ids


def search_count(http_fn: HttpFn, term: str = SEARCH_PROBE_TERM) -> int:
    """
    Count messages the mailbox `$search` index returns for a broad probe term.
    A fully-wiped mailbox returns 0. (Graph $search paginates by nextLink.)
    """
    count = 0
    url = f'{GRAPH}/me/messages?$search={_quote(term)}&$top=100&$select=id'
    while url:
        data = http_fn("GET", url) or {}
        count += len(data.get("value", []))
        url = data.get("@odata.nextLink") or ""
    return count


def _quote(term: str) -> str:
    # Graph accepts the search term URL-quoted; the mock http_fn matches on the
    # path prefix so the exact quoting is not load-bearing for tests.
    from urllib.parse import quote

    return quote(term, safe='"')


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def wipe_all_folders(http_fn: HttpFn, dry_run: bool = False) -> dict:
    """
    Recurse ALL folders, delete every message, then verify the mailbox is empty
    two ways: (1) every folder enumerates 0 messages, and (2) the `$search`
    index probe returns 0. Returns a stats dict; `verified` is True only when
    both checks pass.

    The caller MUST have already passed `check_wipe_allowed` — this function
    performs the destructive deletes.
    """
    folders = walk_folders(http_fn)
    deleted = 0
    for folder in folders:
        ids = list_message_ids(http_fn, folder["id"])
        for mid in ids:
            if not dry_run:
                http_fn("DELETE", f"{GRAPH}/me/messages/{mid}")
            deleted += 1

    # Verify: re-enumerate every folder + probe the search index.
    remaining = 0
    if not dry_run:
        for folder in folders:
            remaining += len(list_message_ids(http_fn, folder["id"]))
    search_remaining = 0 if dry_run else search_count(http_fn)

    return {
        "folders": len(folders),
        "deleted": deleted,
        "remaining": remaining,
        "searchRemaining": search_remaining,
        "verified": (not dry_run) and remaining == 0 and search_remaining == 0,
        "dryRun": dry_run,
    }
