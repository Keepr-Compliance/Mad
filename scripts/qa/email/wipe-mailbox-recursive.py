#!/usr/bin/env python3
"""
Recursive M365 mailbox wipe for the QA harness (BACKLOG-1851 / QA-H4).

Empties EVERY mail folder (recursively, including nested childFolders — not just
the 4 well-known folders `seed-m365.py` clears) and then verifies the mailbox is
empty two ways: every folder enumerates 0 messages AND a broad `$search` index
probe returns 0. This makes a reseed reproduce EXACTLY 190/69/37 with 0 ghosts
(absorbs the BACKLOG-1807 18-ghost regression).

The recursion / verification / guard LOGIC lives in `graph_mailbox.py` (pure,
unit-tested in `tests/test_graph_mailbox.py`). This file is the thin transport:
token load, HTTP with 429/503 retry, and enforcing the destructive-op guard.

IMPORTANT — Python + SSL on macOS: use /usr/bin/python3 (Apple system Python;
has SSL bundled). pyenv / Homebrew Pythons frequently lack SSL.

DESTRUCTIVE-OP GUARD (SR ruling, BACKLOG-1851): this tool REFUSES to run unless
  (a) the token's mailbox owner is on the QA allowlist (default: the izzy demo),
      and
  (b) you pass `--confirm-mailbox <that exact address>`.
An accidental production wipe is therefore structurally impossible.

Usage:
    /usr/bin/python3 scripts/qa/email/wipe-mailbox-recursive.py \\
        --confirm-mailbox agent@izzyrescue.org \\
        [--token-file ~/.keepr-qa/token.json] \\
        [--allow-extra someone@qa.example] \\
        [--dry-run]

Token JSON format: { "access_token": "..." }

Exit codes: 0 wiped + verified (or dry-run); 1 not verified / refused / error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import graph_mailbox as gm  # noqa: E402


def load_token(path: Path) -> str:
    if not path.exists():
        sys.exit(f"Token file not found: {path}")
    with path.open() as f:
        data = json.load(f)
    tok = data.get("access_token")
    if not tok:
        sys.exit(f"Token file {path} missing 'access_token'")
    return tok


def make_http_fn(token: str):
    """A real Graph http_fn with 429/503 retry honouring Retry-After."""

    def http_fn(method: str, url: str, body: dict | None = None):
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        for _attempt in range(6):
            headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
            if payload is not None:
                headers["Content-Type"] = "application/json"
            # $search requires the ConsistencyLevel: eventual header.
            if "$search" in url:
                headers["ConsistencyLevel"] = "eventual"
            req = urllib.request.Request(url, data=payload, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req) as resp:
                    raw = resp.read()
                    return json.loads(raw.decode("utf-8")) if raw else None
            except urllib.error.HTTPError as e:
                if e.code in (429, 503):
                    wait = int(e.headers.get("Retry-After", "5"))
                    print(f"[wipe] throttled ({e.code}), waiting {wait}s …", flush=True)
                    time.sleep(wait)
                    continue
                if e.code == 404:
                    return None
                body_text = e.read().decode("utf-8", errors="replace")
                sys.exit(f"Graph error {e.code}: {body_text}")
        sys.exit("giving up after repeated throttling")

    return http_fn


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--token-file", type=Path, default=Path.home() / ".keepr-qa" / "token.json")
    p.add_argument(
        "--confirm-mailbox",
        help="the exact mailbox address you intend to wipe (must match the token owner)",
    )
    p.add_argument(
        "--allow-extra",
        action="append",
        default=[],
        help="additional QA address(es) to permit beyond the built-in allowlist",
    )
    p.add_argument("--dry-run", action="store_true", help="enumerate + report; delete nothing")
    args = p.parse_args()

    # Guard FIRST — refuse OFFLINE (no network) unless the operator explicitly
    # confirms the target mailbox. This makes it impossible to even ping Graph
    # (with a stale/expired token) without intent (SR ruling, BACKLOG-1851).
    if not args.confirm_mailbox:
        print(
            "[wipe] REFUSED — pass --confirm-mailbox <address> to acknowledge the "
            "destructive recursive delete (must match the token's mailbox owner).",
            file=sys.stderr,
        )
        return 1

    if not args.token_file.exists():
        print(f"[wipe] token file not found: {args.token_file}", file=sys.stderr)
        return 1

    token = load_token(args.token_file)
    http_fn = make_http_fn(token)

    owner = gm.get_mailbox_owner(http_fn)
    allowlist = set(gm.DEFAULT_QA_ALLOWLIST) | {a.lower() for a in args.allow_extra}
    allowed, reason = gm.check_wipe_allowed(owner, args.confirm_mailbox, allowlist)
    print(f"[wipe] mailbox owner: {owner or '(unresolved)'}")
    print(f"[wipe] guard: {reason}")
    if not allowed:
        print("[wipe] REFUSED — destructive-op guard not satisfied.", file=sys.stderr)
        return 1

    stats = gm.wipe_all_folders(http_fn, dry_run=args.dry_run)
    print(
        f"[wipe] folders={stats['folders']} deleted={stats['deleted']} "
        f"remaining={stats['remaining']} searchRemaining={stats['searchRemaining']} "
        f"verified={stats['verified']} dryRun={stats['dryRun']}"
    )
    if args.dry_run:
        return 0
    if not stats["verified"]:
        print(
            f"[wipe] NOT VERIFIED — {stats['remaining']} message(s) remain in folders, "
            f"{stats['searchRemaining']} in the $search index.",
            file=sys.stderr,
        )
        return 1
    print("[wipe] DONE — mailbox empty (all folders + $search = 0).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
