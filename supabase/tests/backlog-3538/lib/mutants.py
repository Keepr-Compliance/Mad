#!/usr/bin/env python3
"""BACKLOG-3538 mutants of 20261007210000_backlog_3538_invite_accept_hardening.sql.

Each mutant is a list of exact-string edits. `apply` raises unless every
pattern occurs exactly once (checked in order, on the text as already edited),
so a mutant that did not apply can never be counted.

Targets name control files: controls/<name>.sql here, else
../backlog-3679/controls/<name>.sql.

usage: mutants.py list                      -> name|expected|targets
       mutants.py apply <name> <migration> <out-migration>
       mutants.py classify < status-lines   -> INVALID | KILLED | SURVIVED

classify: INVALID if any ERROR line or no status line; KILLED if at least one
assertion FAIL; SURVIVED if only PASS. `expected` = survivor means review, not a
control, holds that mutant (run.sh prints EXPECTED SURVIVOR for it).
"""
import sys

PIN = "  -- BACKLOG-3538: the join date of an accepted invite is the server's time,\n  -- never a client-supplied value.\n  NEW.joined_at := now();\n\n"
CLAIM = ("    REVOKE EXECUTE ON FUNCTION public.claim_pending_invite() FROM PUBLIC, anon;\n"
         "    GRANT EXECUTE ON FUNCTION public.claim_pending_invite() TO authenticated, service_role;\n")
DROP = "DROP FUNCTION IF EXISTS public.handle_new_user_invitation_link();"

MUTANTS = {
    # name: (expected, [(old, new), ...], targets)
    "n01-no-pin": ("kill", [(PIN, "")], "k11-accept-pins-joined-at"),
    "n02-pin-every-update": ("kill", [
        (PIN, ""),
        ("  -- Only client roles are limited.", "  NEW.joined_at := now();\n  -- Only client roles are limited."),
    ], "k14-other-writers-keep-joined-at"),
    "n03-pin-only-if-null": ("kill", [("NEW.joined_at := now();", "NEW.joined_at := COALESCE(NEW.joined_at, now());")],
                             "k11-accept-pins-joined-at"),
    "n04-joined-at-not-free": ("kill", [("ARRAY['user_id', 'joined_at', 'license_status',", "ARRAY['user_id', 'license_status',")],
                               "k03-invitee-callback-accepts k11-accept-pins-joined-at"),
    "n05-revoke-anon-only": ("kill", [("claim_pending_invite() FROM PUBLIC, anon;", "claim_pending_invite() FROM anon;")],
                             "k12-anon-cannot-claim"),
    "n06-revoke-authenticated-too": ("kill", [(CLAIM, "    REVOKE EXECUTE ON FUNCTION public.claim_pending_invite() FROM PUBLIC, anon, authenticated;\n")],
                                     "k07-definer-and-service-paths k12-anon-cannot-claim"),
    "n07-no-drop": ("kill", [(DROP, "REVOKE EXECUTE ON FUNCTION public.handle_new_user_invitation_link() FROM PUBLIC, anon, authenticated;")],
                    "k13-link-function-dropped"),
    "n08-drop-cascade": ("survivor", [(DROP, DROP[:-1] + " CASCADE;")], "k13-link-function-dropped"),
    "n09-no-existence-check": ("survivor", [("IF to_regprocedure('public.claim_pending_invite()') IS NOT NULL THEN", "IF true THEN")],
                               "k12-anon-cannot-claim k07-definer-and-service-paths"),
    "n10-pin-before-admin-branch": ("kill", [
        (PIN, ""),
        ("  -- Organization admins edit members", "  NEW.joined_at := now();\n  -- Organization admins edit members"),
    ], "k14-other-writers-keep-joined-at"),
}


def classify(lines):
    status = [l.split("|", 1)[0] for l in lines if l.split("|", 1)[0] in ("PASS", "FAIL", "ERROR")]
    if not status or "ERROR" in status:
        return "INVALID"
    if "FAIL" in status:
        return "KILLED"
    return "SURVIVED"


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "classify":
        print(classify(sys.stdin.read().splitlines()))
    elif cmd == "list":
        for k, (expected, _edits, targets) in MUTANTS.items():
            print(f"{k}|{expected}|{targets}")
    elif cmd == "apply":
        name, mig, out_mig = sys.argv[2:5]
        _expected, edits, _targets = MUTANTS[name]
        src = open(mig).read()
        for old, new in edits:
            n = src.count(old)
            if n != 1:
                raise SystemExit(f"mutant {name}: pattern occurs {n} times (need exactly 1): {old[:60]!r}")
            src = src.replace(old, new)
        open(out_mig, "w").write(src)
    else:
        raise SystemExit("usage: mutants.py list | apply <name> <migration> <out> | classify")


if __name__ == "__main__":
    main()
