#!/usr/bin/env python3
"""
Seed an M365 sandbox mailbox with a corpus of .eml files, preserving
reply-chain threading via In-Reply-To + References headers.

BACKLOG-1721: previously each POST got a new Graph conversationId, so reply
chains showed as disconnected emails. We now topologically sort by reply
chain, post originals first, capture the Graph-assigned internetMessageId,
and pass it to subsequent replies via internetMessageHeaders.

Usage:
    python3 scripts/qa/email/seed-m365.py \\
        --corpus /path/to/eml/corpus \\
        --inbox-only \\
        [--token-file ~/.keepr-qa/token.json] \\
        [--dry-run]

Token JSON format:
    { "access_token": "..." }
"""

import argparse
import base64
import email
import email.utils
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from email.message import Message
from pathlib import Path


GRAPH_INBOX = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages"
GRAPH_DRAFTS = "https://graph.microsoft.com/v1.0/me/messages"


def load_token(path: Path) -> str:
    if not path.exists():
        sys.exit(f"Token file not found: {path}")
    with path.open() as f:
        data = json.load(f)
    tok = data.get("access_token")
    if not tok:
        sys.exit(f"Token file {path} missing 'access_token'")
    return tok


def parse_eml(path: Path) -> Message:
    with path.open("rb") as f:
        return email.message_from_binary_file(f)


def get_body(msg: Message) -> tuple[str, str]:
    """Return (content_type, content) preferring text/plain over text/html."""
    plain = None
    html = None
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


SUBJECT_RE_PREFIX = re.compile(r"^(re|fwd?):\s*", re.IGNORECASE)


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
    Order .eml files so that the originating message of every Re: chain
    posts before its replies. Heuristic: subject prefix (Re:/Fwd:).

    Stable within a thread: preserves filename order for siblings, so
    naming the files TX1_01, TX1_02, ... orders them chronologically.
    """
    by_base: dict[str, list[tuple[Path, Message]]] = {}
    for path, msg in corpus:
        subject = (msg.get("Subject") or "").strip()
        base = strip_reply_prefix(subject) or "<no-subject>"
        by_base.setdefault(base, []).append((path, msg))

    out: list[tuple[Path, Message]] = []
    for base, msgs in sorted(by_base.items()):
        # Originals (no Re:/Fwd: prefix) first, sorted by filename
        originals = sorted(
            [m for m in msgs if not SUBJECT_RE_PREFIX.match((m[1].get("Subject") or ""))],
            key=lambda m: m[0].name,
        )
        replies = sorted(
            [m for m in msgs if SUBJECT_RE_PREFIX.match((m[1].get("Subject") or ""))],
            key=lambda m: m[0].name,
        )
        out.extend(originals)
        out.extend(replies)
    return out


def graph_post(url: str, token: str, body: dict, dry_run: bool = False) -> dict:
    if dry_run:
        return {"id": "dry-run", "internetMessageId": f"<dry-run-{os.urandom(4).hex()}@example.invalid>"}

    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        sys.exit(f"Graph error {e.code}: {body_text}")


def to_graph_message(msg: Message, parent_message_id: str | None) -> dict:
    body_type, body_content = get_body(msg)
    subject = msg.get("Subject") or "(no subject)"
    from_addr = email.utils.parseaddr(msg.get("From") or "")[1]
    to_addrs = [email.utils.parseaddr(a)[1] for a in (msg.get_all("To") or [])]
    cc_addrs = [email.utils.parseaddr(a)[1] for a in (msg.get_all("Cc") or [])]
    bcc_addrs = [email.utils.parseaddr(a)[1] for a in (msg.get_all("Bcc") or [])]

    out: dict = {
        "subject": subject,
        "body": {"contentType": body_type, "content": body_content},
        "from": {"emailAddress": {"address": from_addr}} if from_addr else None,
        "toRecipients": [{"emailAddress": {"address": a}} for a in to_addrs if a],
        "ccRecipients": [{"emailAddress": {"address": a}} for a in cc_addrs if a],
        "bccRecipients": [{"emailAddress": {"address": a}} for a in bcc_addrs if a],
    }
    if parent_message_id:
        out["internetMessageHeaders"] = [
            {"name": "In-Reply-To", "value": parent_message_id},
            {"name": "References", "value": parent_message_id},
        ]
    # Drop nulls Graph rejects
    return {k: v for k, v in out.items() if v}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--corpus", required=True, type=Path, help="directory of .eml files")
    p.add_argument("--token-file", type=Path,
                   default=Path.home() / ".keepr-qa" / "token.json")
    p.add_argument("--inbox-only", action="store_true",
                   help="POST into /me/mailFolders/inbox/messages (vs /me/messages)")
    p.add_argument("--dry-run", action="store_true",
                   help="parse + sort + print plan, do NOT call Graph")
    p.add_argument("--limit", type=int, default=0, help="stop after N posts (0 = no limit)")
    p.add_argument("--sleep-ms", type=int, default=200,
                   help="sleep between POSTs to avoid Graph throttling")
    args = p.parse_args()

    if not args.corpus.is_dir():
        sys.exit(f"Corpus path is not a directory: {args.corpus}")

    eml_files = sorted(args.corpus.rglob("*.eml"))
    if not eml_files:
        sys.exit(f"No .eml files found under {args.corpus}")

    corpus = [(f, parse_eml(f)) for f in eml_files]
    ordered = topo_sort_by_thread(corpus)
    print(f"[seed-m365] {len(ordered)} .eml files ordered into thread chains")

    token = "" if args.dry_run else load_token(args.token_file)
    url = GRAPH_INBOX if args.inbox_only else GRAPH_DRAFTS

    # subject-base ⇒ Graph-assigned internetMessageId of the FIRST post
    thread_root: dict[str, str] = {}
    posted = 0

    for idx, (path, msg) in enumerate(ordered, start=1):
        if args.limit and posted >= args.limit:
            print(f"[seed-m365] reached --limit {args.limit}; stopping")
            break

        subject = msg.get("Subject") or "(no subject)"
        base = strip_reply_prefix(subject) or "<no-subject>"
        is_reply = bool(SUBJECT_RE_PREFIX.match(subject))
        parent = thread_root.get(base) if is_reply else None

        graph_msg = to_graph_message(msg, parent)
        print(f"[{idx}/{len(ordered)}] POST {path.name}"
              f" — base='{base[:60]}' is_reply={is_reply}"
              f" parent={'yes' if parent else 'no'}")

        if args.dry_run:
            posted += 1
            continue

        resp = graph_post(url, token, graph_msg)
        msg_id = resp.get("internetMessageId")
        if not is_reply and msg_id:
            thread_root[base] = msg_id

        posted += 1
        if args.sleep_ms > 0:
            time.sleep(args.sleep_ms / 1000.0)

    print(f"[seed-m365] done: posted {posted}/{len(ordered)} messages")
    return 0


if __name__ == "__main__":
    sys.exit(main())
