#!/usr/bin/env python3
"""
Seed a Google Workspace (Gmail) demo mailbox with the .eml corpus for the QA
harness (BACKLOG-1851 / QA-H4). The Gmail counterpart of `seed-m365.py`.

The deterministic message construction (date-shift, base64url raw, In-Reply-To/
References threading, INBOX/SENT label routing, seed plan) lives in the pure,
unit-tested `eml_corpus.py`. This file is the THIN live transport: token load +
Gmail REST calls (`users.messages.insert`, `list`, `batchDelete`). Per the SR
review it stays behind the BACKLOG-1845 gate while the core is exercised by
`tests/test_eml_corpus.py`.

GATING: the Gmail cell is GATED on the Google Workspace tenant (BACKLOG-1845).
The harness `gmailSeeder.ts` reports `gated` (non-fail) when no token exists;
this script simply requires a token to run live. `--dry-run` / `--emit-plan-json`
need only the corpus and touch no network, so the seed set can be verified today.

INGEST CONVERGENCE: insert uses `internalDateSource=dateHeader` so Gmail's
internalDate (-> ParsedEmail.date -> sent_at) follows the shifted Date header,
matching the (subject, shifted-date) canonical set. Provider-normalization
deltas vs Outlook (BACKLOG-1806: no $filter-first, no existence-validation) are
asserted at live time as findings — NOT harness failures.

IMPORTANT — Python + SSL on macOS: use /usr/bin/python3 (Apple system Python).

Usage:
    /usr/bin/python3 scripts/qa/email/seed-gmail.py \\
        --corpus ~/Downloads/demo-mailbox \\
        [--outbound-sender sarah.mitchell@cascaderealty.com] \\
        [--date-shift-months 12] \\
        [--token-file ~/.keepr-qa/gmail-token.json] \\
        [--wipe | --wipe-only] [--dry-run] [--emit-plan-json] [--limit N] [--sleep-ms 120]

Token JSON format: { "access_token": "..." }
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
import eml_corpus as ec  # noqa: E402

GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------

def load_token(path: Path) -> str:
    if not path.exists():
        sys.exit(f"Token file not found: {path}")
    with path.open() as f:
        data = json.load(f)
    tok = data.get("access_token")
    if not tok:
        sys.exit(f"Token file {path} missing 'access_token'")
    return tok


def _http(method: str, url: str, token: str, body: dict | None = None) -> dict | None:
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    for _attempt in range(6):
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=payload, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read()
                return json.loads(raw.decode("utf-8")) if raw else None
        except urllib.error.HTTPError as e:
            if e.code in (429, 503):
                wait = int(e.headers.get("Retry-After", "5"))
                print(f"[seed] throttled ({e.code}), waiting {wait}s …", flush=True)
                time.sleep(wait)
                continue
            body_text = e.read().decode("utf-8", errors="replace")
            sys.exit(f"Gmail error {e.code}: {body_text}")
    sys.exit("giving up after repeated throttling")


def wipe_mailbox(token: str) -> int:
    """Delete every message in the mailbox via list + batchDelete. Returns count."""
    total = 0
    while True:
        data = _http("GET", f"{GMAIL}/messages?maxResults=500", token) or {}
        ids = [m["id"] for m in data.get("messages", [])]
        if not ids:
            break
        _http("POST", f"{GMAIL}/messages/batchDelete", token, {"ids": ids})
        total += len(ids)
        print(f"[wipe] batchDelete {len(ids)} (running total {total})", flush=True)
    # Verify empty.
    data = _http("GET", f"{GMAIL}/messages?maxResults=1", token) or {}
    remaining = len(data.get("messages", []))
    print(f"[wipe] DONE — {total} deleted; remaining={remaining}", flush=True)
    return total


# ---------------------------------------------------------------------------
# Corpus loading
# ---------------------------------------------------------------------------

def load_corpus(corpus_dir: Path) -> list[tuple[str, bytes]]:
    files = sorted(corpus_dir.rglob("*.eml"))
    if not files:
        sys.exit(f"No .eml files found under {corpus_dir}")
    return [(f.name, f.read_bytes()) for f in files]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--corpus", type=Path, help="directory of .eml files (required unless --wipe-only)")
    p.add_argument("--token-file", type=Path, default=Path.home() / ".keepr-qa" / "gmail-token.json")
    p.add_argument("--outbound-sender", default=ec.DEFAULT_OUTBOUND_SENDER)
    p.add_argument("--date-shift-months", type=int, default=0)
    p.add_argument("--source-tz", default=ec.DEFAULT_SOURCE_TZ)
    p.add_argument("--wipe", action="store_true", help="wipe before seeding")
    p.add_argument("--wipe-only", action="store_true", help="wipe then exit")
    p.add_argument("--dry-run", action="store_true", help="build plan; no network")
    p.add_argument("--emit-plan-json", action="store_true", help="print the seed plan as JSON and exit")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--sleep-ms", type=int, default=120)
    args = p.parse_args()

    # ---- wipe-only ---------------------------------------------------------
    if args.wipe_only:
        if args.dry_run:
            print("[wipe-only] dry-run — no Gmail calls made")
            return 0
        wipe_mailbox(load_token(args.token_file))
        return 0

    if not args.corpus or not args.corpus.is_dir():
        p.error("--corpus <dir> is required unless --wipe-only")

    corpus = load_corpus(args.corpus)

    # ---- plan (no network) -------------------------------------------------
    plan = ec.build_seed_plan(
        corpus, args.date_shift_months, args.outbound_sender, args.source_tz
    )
    if args.emit_plan_json:
        print(json.dumps(plan, indent=2))
        return 0
    if args.dry_run:
        print(f"[seed] {len(plan)} emails planned (thread-ordered, date-shifted)")
        for row in plan[:10]:
            print(f"  {row['label']:6s} {row['shiftedDate']}  reply={row['isReply']}  {row['file']}")
        if len(plan) > 10:
            print(f"  … and {len(plan) - 10} more")
        return 0

    # ---- live seed ---------------------------------------------------------
    token = load_token(args.token_file)
    if args.wipe:
        wipe_mailbox(token)

    by_name = dict(corpus)
    parsed = [(name, ec.parse_eml_bytes(raw)) for name, raw in corpus]
    ordered = [name for name, _ in ec.topo_sort_by_thread(parsed)]

    thread_root: dict[str, str] = {}
    posted = 0
    for idx, name in enumerate(ordered, start=1):
        if args.limit and posted >= args.limit:
            print(f"[seed] reached --limit {args.limit}; stopping", flush=True)
            break
        raw = by_name[name]
        msg = ec.parse_eml_bytes(raw)
        subject = str(msg.get("Subject") or "")
        base = ec.strip_reply_prefix(subject) or "<no-subject>"
        reply = ec.is_reply(subject)
        parent = thread_root.get(base) if reply else None

        built = ec.build_gmail_insert(raw, name, args.date_shift_months, parent, args.outbound_sender)
        if not reply:
            thread_root[base] = built["messageId"]

        print(
            f"[{idx}/{len(ordered)}] {built['labelIds'][0]:6s} {name}  reply={reply}",
            flush=True,
        )
        _http(
            "POST",
            f"{GMAIL}/messages?internalDateSource=dateHeader",
            token,
            {"raw": built["raw"], "labelIds": built["labelIds"]},
        )
        posted += 1
        if args.sleep_ms > 0:
            time.sleep(args.sleep_ms / 1000.0)

    print(f"[seed] done: posted {posted}/{len(ordered)} messages", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
