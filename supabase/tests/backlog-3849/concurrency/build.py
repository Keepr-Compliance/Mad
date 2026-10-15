#!/usr/bin/env python3
"""BACKLOG-3849 S1-S3: build the claim-concurrency fixture from the 3845 migration file.

Transcribes `billing_outbox` and `billing_outbox_claim` from
supabase/migrations/20261011230913_backlog_3845_billing_foundation.sql (foreign
keys removed: the throwaway database has no auth.users / organizations) and
writes one claim function per variant. Each mutant edit must match exactly once,
else this exits 1 and nothing runs. Prints `MUTATION APPLIED <variant>: <line>`.

usage: build.py <migration file> <out.sql>
"""
import re
import sys

MUTANTS = {
    # S1: no row lock -> two overlapping claims both take the row.
    "nolock": ("     FOR UPDATE SKIP LOCKED\n", "\n"),
    # Latency only (recorded, expected NOT to go red): FOR UPDATE without SKIP LOCKED.
    "noskip": ("     FOR UPDATE SKIP LOCKED\n", "     FOR UPDATE\n"),
    # S2: no lease predicate -> a later drain re-claims a row still being worked.
    "nolease": ("       AND (b.claimed_until IS NULL OR b.claimed_until < now())\n", "\n"),
    # S3: no mode filter -> a live claim takes the test row.
    "nomode": ("     WHERE b.stripe_mode = p_mode\n       AND b.processed_at IS NULL\n",
               "     WHERE b.processed_at IS NULL\n"),
}


def block(src: str, start: str, end: str) -> str:
    i = src.index(start)
    j = src.index(end, i) + len(end)
    return src[i:j]


def main() -> int:
    mig, out = sys.argv[1], sys.argv[2]
    src = open(mig).read()
    table = block(src, "CREATE TABLE IF NOT EXISTS public.billing_outbox (", "\n);\n")
    table, n = re.subn(r" REFERENCES [a-z_.()]+ ON DELETE CASCADE", "", table)
    if n != 2:
        print(f"ERROR: expected 2 foreign keys in billing_outbox, found {n}")
        return 1
    fn = block(src, "CREATE OR REPLACE FUNCTION public.billing_outbox_claim(", "$fn$;\n")
    parts = ["CREATE EXTENSION IF NOT EXISTS pgcrypto;\n", table, "\n"]
    parts.append(fn.replace("public.billing_outbox_claim(", "public.claim_orig(", 1))
    for name, (old, new) in MUTANTS.items():
        c = fn.count(old)
        if c != 1:
            print(f"ERROR: mutant {name}: pattern found {c} times, expected 1")
            return 1
        m = fn.replace(old, new).replace("public.billing_outbox_claim(", f"public.claim_{name}(", 1)
        print(f"MUTATION APPLIED {name}: {old.strip()!r} -> {new.strip()!r}")
        parts.append(m)
    open(out, "w").write("\n".join(parts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
