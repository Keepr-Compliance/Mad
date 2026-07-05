#!/usr/bin/env python3
"""
Seed an M365 sandbox mailbox with a corpus of .eml files, preserving
reply-chain threading and realistic delivery timestamps.

IMPORTANT — Python + SSL on macOS:
    Use /usr/bin/python3 (Apple system Python; has SSL bundled).
    pyenv / Homebrew Pythons are frequently compiled without SSL and will
    fail with:  urllib.error.URLError: <urlopen error [SSL: CERTIFICATE_VERIFY_FAILED]>
    Run as:  /usr/bin/python3 scripts/qa/email/seed-m365.py ...

THREADING (BACKLOG-1721):
    Graph returns 400 InvalidInternetMessageHeader for In-Reply-To/References
    sent via internetMessageHeaders (only X-* custom headers are allowed on
    direct POST).  Instead we use MAPI extended properties:
        PR_IN_REPLY_TO_ID       String 0x1042
        PR_INTERNET_REFERENCES  String 0x1039
    Verified live 2026-07-03: child messages adopt the parent conversationId.

FOLDER ROUTING:
    Messages whose From address matches --outbound-sender are POSTed to
    Sent Items; all others go to Inbox.  (Old --inbox-only defaulted to
    /me/messages which is the Drafts folder — removed.)

DATE-SHIFT:
    --date-shift-months N reads the .eml Date header, shifts by N months,
    then sets PR_MESSAGE_DELIVERY_TIME (0x0E06) and PR_CLIENT_SUBMIT_TIME
    (0x0039) via singleValueExtendedProperties so Graph records the synthetic
    delivery time rather than the POST timestamp.  Without this every seeded
    email lands "today" and falls outside any audit date window.

WIPE:
    --wipe empties inbox/sentitems/drafts/deleteditems before seeding.
    --wipe-only does the wipe then exits without seeding.

Usage:
    /usr/bin/python3 scripts/qa/email/seed-m365.py \\
        --corpus /path/to/eml/corpus \\
        [--outbound-sender sarah.mitchell@cascaderealty.com] \\
        [--date-shift-months 6] \\
        [--wipe] \\
        [--token-file ~/.keepr-qa/token.json] \\
        [--dry-run] [--limit N] [--sleep-ms 150]

Token JSON format:
    { "access_token": "..." }
"""

from __future__ import annotations

import argparse
import email
import email.utils
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.message import Message
from pathlib import Path


GRAPH = "https://graph.microsoft.com/v1.0"
SUBJECT_RE_PREFIX = re.compile(r"^(re|fwd?):\s*", re.IGNORECASE)
WIPE_FOLDERS = ("inbox", "sentitems", "drafts", "deleteditems")


# ---------------------------------------------------------------------------
# Token
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


# ---------------------------------------------------------------------------
# HTTP helpers (429/503 retry with Retry-After)
# ---------------------------------------------------------------------------

def _http(method: str, url: str, token: str, body: dict | None = None) -> dict | None:
    """HTTP call with automatic 429/503 retry honouring Retry-After."""
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    for _attempt in range(6):
        headers: dict = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        }
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
            if e.code == 404:
                return None
            body_text = e.read().decode("utf-8", errors="replace")
            sys.exit(f"Graph error {e.code}: {body_text}")
    sys.exit("giving up after repeated throttling")


def graph_post(url: str, token: str, body: dict, dry_run: bool = False) -> dict:
    if dry_run:
        return {
            "id": "dry-run",
            "internetMessageId": f"<dry-run-{os.urandom(4).hex()}@example.invalid>",
        }
    result = _http("POST", url, token, body)
    return result or {}


# ---------------------------------------------------------------------------
# Wipe helpers
# ---------------------------------------------------------------------------

def wipe_mailbox(token: str) -> int:
    """Delete all messages in inbox/sentitems/drafts/deleteditems. Returns total deleted."""
    total = 0
    for folder in WIPE_FOLDERS:
        print(f"[wipe] clearing {folder} …", flush=True)
        while True:
            url = f"{GRAPH}/me/mailFolders/{folder}/messages?$top=100&$select=id"
            data = _http("GET", url, token)
            ids = [m["id"] for m in (data or {}).get("value", [])]
            if not ids:
                break
            for mid in ids:
                _http("DELETE", f"{GRAPH}/me/messages/{mid}", token)
                total += 1
                time.sleep(0.05)
            print(f"[wipe]   {folder}: deleted batch of {len(ids)} (running total {total})", flush=True)
    print(f"[wipe] DONE — {total} messages deleted", flush=True)
    # Verify empty
    for folder in WIPE_FOLDERS:
        data = _http("GET", f"{GRAPH}/me/mailFolders/{folder}/messages?$top=1&$select=id", token)
        n = len((data or {}).get("value", []))
        print(f"[wipe] verify {folder}: {'EMPTY' if n == 0 else 'NOT EMPTY!'}", flush=True)
    return total


# ---------------------------------------------------------------------------
# EML parsing
# ---------------------------------------------------------------------------

def parse_eml(path: Path) -> Message:
    with path.open("rb") as f:
        return email.message_from_binary_file(f)


def get_body(msg: Message) -> tuple[str, str]:
    """Return (content_type, content) preferring text/plain over text/html."""
    plain = html = None
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct == "text/plain" and plain is None:
                plain = part.get_payload(decode=True)
            elif ct == "text/html" and html is None:
                html = part.get_payload(decode=True)
    else:
        payload = msg.get_payload(decode=True)
        if msg.get_content_type() == "text/html":
            html = payload
        else:
            plain = payload
    if plain:
        return "text", plain.decode("utf-8", errors="replace")
    if html:
        return "html", html.decode("utf-8", errors="replace")
    return "text", ""


def parse_addr_list(header_values: list[str] | None) -> list[dict]:
    """Parse an address list preserving display names; handles ; separators."""
    out = []
    for val in (header_values or []):
        # Some MUAs (Outlook) use semicolons; RFC 2822 uses commas.
        # Coerce to str — Python 3.9 email API may return Header objects.
        normalized = str(val).replace(";", ",")
        for name, addr in email.utils.getaddresses([normalized]):
            if not addr:
                continue
            entry: dict = {"address": addr}
            if name:
                entry["name"] = name
            out.append({"emailAddress": entry})
    return out


# ---------------------------------------------------------------------------
# Thread topological sort
# ---------------------------------------------------------------------------

def strip_reply_prefix(subject: str) -> str:
    """'Re: Re: Foo' -> 'Foo' (recursive strip)."""
    prev = None
    cur = subject
    while prev != cur:
        prev = cur
        cur = SUBJECT_RE_PREFIX.sub("", cur).strip()
    return cur


def topo_sort_by_thread(corpus: list[tuple[Path, Message]]) -> list[tuple[Path, Message]]:
    """
    Order .eml files so that the originating message of every Re: chain posts
    before its replies.  Heuristic: subject prefix (Re:/Fwd:).

    Stable within a thread: preserves filename order for siblings, so
    naming the files TX1_01.eml, TX1_02.eml … orders them chronologically.
    """
    by_base: dict[str, list[tuple[Path, Message]]] = {}
    for path, msg in corpus:
        subject = str(msg.get("Subject") or "").strip()
        base = strip_reply_prefix(subject) or "<no-subject>"
        by_base.setdefault(base, []).append((path, msg))

    out: list[tuple[Path, Message]] = []
    for base, msgs in sorted(by_base.items()):
        originals = sorted(
            [m for m in msgs if not SUBJECT_RE_PREFIX.match(str(m[1].get("Subject") or ""))],
            key=lambda m: m[0].name,
        )
        replies = sorted(
            [m for m in msgs if SUBJECT_RE_PREFIX.match(str(m[1].get("Subject") or ""))],
            key=lambda m: m[0].name,
        )
        out.extend(originals)
        out.extend(replies)
    return out


# ---------------------------------------------------------------------------
# Date shift
# ---------------------------------------------------------------------------

def shift_months(dt: datetime, months: int) -> datetime:
    """Add N calendar months to dt, clamping day for short months."""
    m = dt.month - 1 + months
    year = dt.year + m // 12
    month = m % 12 + 1
    days_in_month = [
        31,
        29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28,
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ][month - 1]
    day = min(dt.day, days_in_month)
    return dt.replace(year=year, month=month, day=day)


# ---------------------------------------------------------------------------
# Graph message builder
# ---------------------------------------------------------------------------

def to_graph_message(
    msg: Message,
    parent_message_id: str | None,
    shifted_iso: str | None,
) -> dict:
    body_type, body_content = get_body(msg)

    from_name, from_addr = email.utils.parseaddr(str(msg.get("From") or ""))
    from_entry: dict = {"address": from_addr}
    if from_name:
        from_entry["name"] = from_name

    out: dict = {
        "subject": str(msg.get("Subject") or "(no subject)"),
        "body": {"contentType": body_type, "content": body_content},
        "from": {"emailAddress": from_entry} if from_addr else None,
        "toRecipients": parse_addr_list(msg.get_all("To")),
        "ccRecipients": parse_addr_list(msg.get_all("Cc")),
        "bccRecipients": parse_addr_list(msg.get_all("Bcc")),
    }

    # Threading + date via MAPI extended properties.
    # Graph rejects In-Reply-To/References in internetMessageHeaders (only X-*
    # custom headers allowed on POST). MAPI property approach verified live
    # 2026-07-03: child messages adopt the parent conversationId.
    props = []
    if parent_message_id:
        props += [
            {"id": "String 0x1042", "value": parent_message_id},  # PR_IN_REPLY_TO_ID
            {"id": "String 0x1039", "value": parent_message_id},  # PR_INTERNET_REFERENCES
        ]
    if shifted_iso:
        props += [
            {"id": "SystemTime 0x0E06", "value": shifted_iso},  # PR_MESSAGE_DELIVERY_TIME
            {"id": "SystemTime 0x0039", "value": shifted_iso},  # PR_CLIENT_SUBMIT_TIME
        ]
    if props:
        out["singleValueExtendedProperties"] = props

    return {k: v for k, v in out.items() if v}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--corpus", type=Path,
                   help="directory of .eml files (required unless --wipe-only)")
    p.add_argument("--token-file", type=Path,
                   default=Path.home() / ".keepr-qa" / "token.json")
    p.add_argument("--outbound-sender", default="sarah.mitchell@cascaderealty.com",
                   help="From address routed to Sent Items; all others go to Inbox")
    p.add_argument("--date-shift-months", type=int, default=0,
                   help="shift each .eml Date header by N months before setting delivery time")
    p.add_argument("--dry-run", action="store_true",
                   help="parse + sort + print plan; do NOT call Graph")
    p.add_argument("--limit", type=int, default=0,
                   help="stop after N posts (0 = unlimited)")
    p.add_argument("--sleep-ms", type=int, default=150,
                   help="ms to sleep between Graph POSTs (default: 150)")
    p.add_argument("--wipe", action="store_true",
                   help="empty inbox/sentitems/drafts/deleteditems before seeding")
    p.add_argument("--wipe-only", action="store_true",
                   help="wipe mailbox then exit without seeding")
    args = p.parse_args()

    # ---- wipe-only shortcut ------------------------------------------------
    if args.wipe_only:
        if args.dry_run:
            print("[wipe-only] dry-run — no Graph calls made")
            return 0
        token = load_token(args.token_file)
        wipe_mailbox(token)
        return 0

    # ---- seed path ---------------------------------------------------------
    if not args.corpus:
        p.error("--corpus is required unless --wipe-only")
    if not args.corpus.is_dir():
        sys.exit(f"Corpus path is not a directory: {args.corpus}")

    eml_files = sorted(args.corpus.rglob("*.eml"))
    if not eml_files:
        sys.exit(f"No .eml files found under {args.corpus}")

    corpus = [(f, parse_eml(f)) for f in eml_files]
    ordered = topo_sort_by_thread(corpus)
    print(f"[seed] {len(ordered)} emails ordered into thread chains", flush=True)

    token = "" if args.dry_run else load_token(args.token_file)

    if args.wipe and not args.dry_run:
        wipe_mailbox(token)

    thread_root: dict[str, str] = {}
    posted = 0

    for idx, (path, msg) in enumerate(ordered, start=1):
        if args.limit and posted >= args.limit:
            print(f"[seed] reached --limit {args.limit}; stopping", flush=True)
            break

        subject = str(msg.get("Subject") or "(no subject)")
        base = strip_reply_prefix(subject) or "<no-subject>"
        is_reply = bool(SUBJECT_RE_PREFIX.match(subject))
        parent = thread_root.get(base) if is_reply else None

        # Date shift
        shifted_iso: str | None = None
        if args.date_shift_months:
            try:
                dt = email.utils.parsedate_to_datetime(str(msg.get("Date") or ""))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                shifted_iso = (
                    shift_months(dt, args.date_shift_months)
                    .astimezone(timezone.utc)
                    .strftime("%Y-%m-%dT%H:%M:%SZ")
                )
            except Exception as exc:
                print(f"[seed] WARN no usable Date in {path.name}: {exc}", flush=True)

        # Folder routing: outbound-sender → Sent Items, else Inbox
        _, sender = email.utils.parseaddr(str(msg.get("From") or ""))
        folder = "sentitems" if sender.lower() == args.outbound_sender.lower() else "inbox"
        url = f"{GRAPH}/me/mailFolders/{folder}/messages"

        print(
            f"[{idx}/{len(ordered)}] {folder:9s} {path.name}"
            f"  reply={is_reply} parent={'y' if parent else 'n'}"
            f"  date={shifted_iso or 'eml-native'}",
            flush=True,
        )

        if args.dry_run:
            posted += 1
            continue

        resp = graph_post(url, token, to_graph_message(msg, parent, shifted_iso))
        mid = resp.get("internetMessageId")
        if not is_reply and mid:
            thread_root[base] = mid

        posted += 1
        if args.sleep_ms > 0:
            time.sleep(args.sleep_ms / 1000.0)

    print(f"[seed] done: posted {posted}/{len(ordered)} messages", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
