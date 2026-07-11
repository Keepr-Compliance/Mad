#!/usr/bin/env python3
"""
Shared, PURE, unit-testable corpus helpers for the QA email seeders
(BACKLOG-1851 / QA-H4).

This module contains ZERO network I/O. It is the deterministic core the SR
review asked us to invest in: EML parsing, thread ordering, date-shift, and the
Gmail `users.messages.insert` payload builder. The live transport (token load,
HTTP) lives in the thin CLI wrappers (`seed-gmail.py`) so it can stay behind the
BACKLOG-1845 gate while THIS logic is exercised by `tests/test_eml_corpus.py`.

Importable name (underscored) so tests + CLIs can `from eml_corpus import ...`;
the seeders themselves keep the repo's `seed-*.py` (hyphen) convention.

SET IDENTITY (load-bearing): membership is keyed by (subject, shifted-date) in
the corpus author's LOCAL timezone — NEVER by Message-ID. Corpus .eml files
carry no Message-ID. For Gmail we synthesize deterministic Message-IDs purely to
reconstruct reply threading; they are NEVER used for set membership.

CONVERGENCE ON ParsedEmail: the seeded messages carry From/To/Cc/Bcc, Subject,
a shifted Date header, and the decoded body, so the app's gmailFetchService maps
them to the same (subject, shifted-date, participants) the Outlook path yields.
Provider-normalization deltas (BACKLOG-1806) are asserted at live time, not here.
"""

from __future__ import annotations

import base64
import email
import email.utils
import hashlib
import re
from datetime import datetime, timezone
from email.message import Message
from typing import Optional

try:  # Python 3.9+ (Apple system python3 has it); degrade gracefully.
    from zoneinfo import ZoneInfo

    _HAVE_ZONEINFO = True
except Exception:  # pragma: no cover - only on ancient interpreters
    ZoneInfo = None  # type: ignore
    _HAVE_ZONEINFO = False

SUBJECT_RE_PREFIX = re.compile(r"^(re|fwd?):\s*", re.IGNORECASE)
DEFAULT_SOURCE_TZ = "America/Los_Angeles"
DEFAULT_OUTBOUND_SENDER = "sarah.mitchell@cascaderealty.com"


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_eml_bytes(raw: bytes) -> Message:
    """Parse raw .eml bytes into an email.message.Message."""
    return email.message_from_bytes(raw)


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


def strip_reply_prefix(subject: str) -> str:
    """'Re: Re: Foo' -> 'Foo' (recursive strip)."""
    prev = None
    cur = subject
    while prev != cur:
        prev = cur
        cur = SUBJECT_RE_PREFIX.sub("", cur).strip()
    return cur


def is_reply(subject: str) -> bool:
    return bool(SUBJECT_RE_PREFIX.match(subject.strip()))


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


def parse_date_header(value: Optional[str]) -> Optional[datetime]:
    """Parse an RFC-2822 Date header; assume UTC when tz-naive."""
    if not value:
        return None
    try:
        dt = email.utils.parsedate_to_datetime(str(value))
    except Exception:
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def local_shifted_date(
    original_date: Optional[str],
    months: int,
    source_tz: str = DEFAULT_SOURCE_TZ,
) -> Optional[str]:
    """
    The canonical (subject, shifted-date) key: shift by N months, then take the
    calendar day in the corpus author's LOCAL timezone (matches the checklist &
    H3's db-assert tz conversion). Returns 'YYYY-MM-DD' or None.
    """
    dt = parse_date_header(original_date)
    if dt is None:
        return None
    shifted = shift_months(dt, months)
    if _HAVE_ZONEINFO:
        try:
            shifted = shifted.astimezone(ZoneInfo(source_tz))
        except Exception:
            pass
    return shifted.strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Thread ordering + synthetic Message-IDs
# ---------------------------------------------------------------------------

def synth_message_id(file_key: str) -> str:
    """
    Deterministic synthetic Message-ID for a corpus file. Corpus .eml files have
    no Message-ID; we synthesize a stable one so Gmail can reconstruct reply
    threading via In-Reply-To/References. NEVER used for set membership.
    """
    digest = hashlib.sha1(file_key.encode("utf-8")).hexdigest()[:16]
    return f"<qa-{digest}@keepr-qa.invalid>"


def topo_sort_by_thread(items: list[tuple[str, Message]]) -> list[tuple[str, Message]]:
    """
    Order (file_key, Message) pairs so a thread's originating message precedes
    its replies. Heuristic: subject prefix (Re:/Fwd:). Stable within a thread by
    file_key, so TX1_01.eml, TX1_02.eml ... order chronologically.
    """
    by_base: dict[str, list[tuple[str, Message]]] = {}
    for key, msg in items:
        subject = str(msg.get("Subject") or "").strip()
        base = strip_reply_prefix(subject) or "<no-subject>"
        by_base.setdefault(base, []).append((key, msg))

    out: list[tuple[str, Message]] = []
    for _base, msgs in sorted(by_base.items()):
        originals = sorted(
            [m for m in msgs if not is_reply(str(m[1].get("Subject") or ""))],
            key=lambda m: m[0],
        )
        replies = sorted(
            [m for m in msgs if is_reply(str(m[1].get("Subject") or ""))],
            key=lambda m: m[0],
        )
        out.extend(originals)
        out.extend(replies)
    return out


# ---------------------------------------------------------------------------
# Gmail insert payload builder (PURE)
# ---------------------------------------------------------------------------

def _sender_address(msg: Message) -> str:
    _name, addr = email.utils.parseaddr(str(msg.get("From") or ""))
    return (addr or "").lower()


def build_gmail_insert(
    raw_eml: bytes,
    file_key: str,
    months: int,
    parent_message_id: Optional[str],
    outbound_sender: str = DEFAULT_OUTBOUND_SENDER,
) -> dict:
    """
    Build a Gmail `users.messages.insert` request body from a corpus .eml.

    - Rewrites the Date header to the shifted date (paired with
      `internalDateSource=dateHeader` at insert time so Gmail's internalDate ->
      ParsedEmail.date -> sent_at reflects the synthetic delivery time).
    - Synthesizes a stable Message-ID; sets In-Reply-To/References to the parent
      when this is a reply (native Gmail threading).
    - Routes to SENT when From == outbound_sender, else INBOX (labelIds).
    - Encodes the full MIME as base64url `raw`.

    Returns { raw, labelIds, messageId, isReply, shiftedDateIso? }.
    """
    msg = parse_eml_bytes(raw_eml)
    subject = str(msg.get("Subject") or "")
    reply = is_reply(subject)

    # Date shift -> rewrite Date header.
    original_date = str(msg.get("Date") or "")
    dt = parse_date_header(original_date)
    shifted_iso: Optional[str] = None
    if dt is not None and months:
        shifted = shift_months(dt, months)
        del msg["Date"]
        msg["Date"] = email.utils.format_datetime(shifted)
        shifted_iso = shifted.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Synthetic Message-ID + threading headers.
    message_id = synth_message_id(file_key)
    del msg["Message-ID"]
    del msg["Message-Id"]
    msg["Message-ID"] = message_id
    if reply and parent_message_id:
        del msg["In-Reply-To"]
        del msg["References"]
        msg["In-Reply-To"] = parent_message_id
        msg["References"] = parent_message_id

    # Folder routing via labels.
    label = "SENT" if _sender_address(msg) == outbound_sender.lower() else "INBOX"

    raw_b64 = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
    return {
        "raw": raw_b64,
        "labelIds": [label],
        "messageId": message_id,
        "isReply": reply,
        "shiftedDateIso": shifted_iso,
    }


def decode_raw(raw_b64: str) -> Message:
    """Inverse of the base64url `raw` field — for tests + verification."""
    return parse_eml_bytes(base64.urlsafe_b64decode(raw_b64.encode("ascii")))


# ---------------------------------------------------------------------------
# Seed plan (for --dry-run / --emit-plan-json, and the seed-set verification)
# ---------------------------------------------------------------------------

def build_seed_plan(
    items: list[tuple[str, bytes]],
    months: int,
    outbound_sender: str = DEFAULT_OUTBOUND_SENDER,
    source_tz: str = DEFAULT_SOURCE_TZ,
) -> list[dict]:
    """
    Deterministic seed plan over a corpus: for each file (in thread order),
    the (subject, shifted-date-local, label, isReply, messageId). This is the
    machine-checkable statement of "what the seeder would insert", assertable
    against the canonical (subject, shifted-date) manifest WITHOUT a live tenant.
    """
    parsed = [(key, parse_eml_bytes(raw)) for key, raw in items]
    ordered_keys = [key for key, _ in topo_sort_by_thread(parsed)]
    by_key = {key: raw for key, raw in items}

    thread_root: dict[str, str] = {}
    plan: list[dict] = []
    for key in ordered_keys:
        raw = by_key[key]
        msg = parse_eml_bytes(raw)
        subject = str(msg.get("Subject") or "")
        base = strip_reply_prefix(subject) or "<no-subject>"
        reply = is_reply(subject)
        parent = thread_root.get(base) if reply else None

        built = build_gmail_insert(raw, key, months, parent, outbound_sender)
        if not reply:
            thread_root[base] = built["messageId"]

        plan.append(
            {
                "file": key,
                "subject": subject,
                "shiftedDate": local_shifted_date(str(msg.get("Date") or ""), months, source_tz),
                "label": built["labelIds"][0],
                "isReply": reply,
                "messageId": built["messageId"],
            }
        )
    return plan
