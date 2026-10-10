#!/usr/bin/env python3
"""BACKLOG-3856 mutants of the migration.

Each mutant is a list of exact-string replacements ("edit"), or a whole-file
replacement ("whole"). `apply` raises unless every edit pattern occurs exactly
once, so a mutant that did not apply can never be counted.

usage: mutants.py list
       mutants.py apply <name> <migration> <out>
       mutants.py classify < status-lines
classify: INVALID (any ERROR or no line), KILLED (>=1 FAIL), SURVIVED (all PASS).
"""
import sys

SEL = "  SELECT u.status INTO v_user_status FROM public.users u WHERE u.id = p_user_id;\n"
CASE = "CASE WHEN v_user_status = 'suspended' THEN 'suspended' ELSE 'active' END"

MUTANTS = {
    # name: ([(kind, old, new)], target controls)
    "m01-constant-active": ([("edit", CASE, "'active'")], "k1 k3 k6"),
    "m02-checks-licenses-status": ([("edit", SEL,
        "  SELECT l.status INTO v_user_status FROM public.licenses l WHERE l.user_id = p_user_id;\n")], "k1 k3"),
    "m03-raise-instead-of-insert": ([("edit", SEL, SEL +
        "  IF v_user_status = 'suspended' THEN RAISE EXCEPTION 'Account suspended' USING ERRCODE = '42501'; END IF;\n"),
        ("edit", CASE, "'active'")], "k1 k3"),
    "m04-client-only-no-server-change": ([("whole", None, "SELECT 1;\n")], "k1 k3"),
    "m05-constant-suspended": ([("edit", CASE, "'suspended'")], "k2"),
    "m06-check-only-in-auth-branch": ([("edit", SEL,
        "  IF COALESCE(auth.role(), '') <> 'service_role' THEN\n  " + SEL + "  END IF;\n")], "k3"),
    "m07-on-conflict-do-update": ([("edit", "ON CONFLICT (user_id) DO NOTHING",
        "ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status")], "k4"),
    "m08-guard-dropped": ([("edit", "RAISE EXCEPTION 'Not allowed for this user' USING ERRCODE = '42501';",
        "NULL;")], "k5"),
    "m09-grant-to-anon": ([("edit",
        "REVOKE EXECUTE ON FUNCTION public.create_active_individual_license(uuid) FROM PUBLIC, anon;",
        "GRANT EXECUTE ON FUNCTION public.create_active_individual_license(uuid) TO PUBLIC, anon;")], "k5"),
    "m10-inverted-test": ([("edit", "v_user_status = 'suspended' THEN", "v_user_status <> 'suspended' THEN")], "k1 k2"),
    "m11-security-invoker": ([("edit", " LANGUAGE plpgsql\n SECURITY DEFINER\n", " LANGUAGE plpgsql\n SECURITY INVOKER\n")], "k1 k5"),
}

def apply(name, src_path, out_path):
    src = open(src_path).read()
    out = src
    for kind, old, new in MUTANTS[name][0]:
        if kind == "whole":
            out = new
            continue
        n = out.count(old)
        if n != 1:
            raise SystemExit(f"mutant {name}: pattern occurs {n} times: {old[:60]!r}")
        out = out.replace(old, new)
    if out == src:
        raise SystemExit(f"mutant {name}: changed nothing")
    open(out_path, "w").write(out)

def classify(lines):
    lines = [l for l in lines if l.strip()]
    if not lines or any(l.startswith("ERROR|") for l in lines):
        return "INVALID"
    return "KILLED" if any(l.startswith("FAIL|") for l in lines) else "SURVIVED"

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "list":
        for k, (_, t) in MUTANTS.items():
            print(f"{k}|{t}")
    elif cmd == "apply":
        apply(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "classify":
        print(classify(sys.stdin.read().splitlines()))
