#!/usr/bin/env python3
"""BACKLOG-3858 mutants of the migration ("mig") and of rollback-3858.sql ("rb").

Each mutant is a list of exact-string replacements (old, new[, count]). `apply`
raises unless every pattern occurs exactly `count` times (default 1), so a
mutant that did not apply is never counted.

usage: mutants.py list                      -> name|file|target controls
       mutants.py apply <name> <src> <out>
       mutants.py classify < status-lines
classify: INVALID (any ERROR or no line), KILLED (>=1 FAIL), SURVIVED (all PASS).
"""
import sys

LOOP_FILTER = (
    "       AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = l.user_id)\n"
    "     ORDER BY l.user_id\n"
)
POSTCHECK = (
    "  IF v_left > 0 THEN\n"
    "    RAISE EXCEPTION 'BACKLOG-3858: % licensed, non-suspended user(s) still without a membership', v_left;\n"
    "  END IF;\n"
)
BAD_RAISE = (
    "  IF cardinality(v_bad) > 0 THEN\n"
    "    RAISE EXCEPTION 'BACKLOG-3858: % user(s) not created: %', cardinality(v_bad), array_to_string(v_bad, ', ');\n"
    "  END IF;\n"
)
PRECHECK = (
    "  IF v_fp IS DISTINCT FROM v_expected_fp THEN\n"
    "    RAISE EXCEPTION 'BACKLOG-3858: _ensure_personal_organization_for body changed (md5 %, expected %); re-review before applying',\n"
    "      v_fp, v_expected_fp;\n"
    "  END IF;\n"
)
LIC_EXCL = "WHERE l.status IS DISTINCT FROM 'suspended'"
USR_EXCL = "AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = l.user_id AND u.status = 'suspended')"
CALL = "    v := public._ensure_personal_organization_for(r.user_id);\n"
HANDROLLED = (
    "    INSERT INTO public.organizations (name, slug, max_seats, personal_owner_user_id)\n"
    "    VALUES ('Personal', 'personal-' || replace(r.user_id::text, '-', ''), 1, r.user_id)\n"
    "    RETURNING jsonb_build_object('status', 'created', 'organization_id', id) INTO v;\n"
    "    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)\n"
    "    VALUES ((v->>'organization_id')::uuid, r.user_id, 'agent', 'active', now());\n"
)
RECORD = (
    "    INSERT INTO public.backlog_3858_personal_org_backfill (user_id, organization_id)\n"
    "    VALUES (r.user_id, (v->>'organization_id')::uuid);\n"
)
RB_DELETE = (
    "   USING public.backlog_3858_personal_org_backfill b\n"
    "   WHERE o.id = b.organization_id\n"
    "     AND o.personal_owner_user_id = b.user_id;\n"
)
RB_OVERRIDES_COND = "                        AND COALESCE(op.feature_overrides, '{}'::jsonb) <> '{}'::jsonb)\n"

MUTANTS = {
    # name: (file, [(old, new)], target controls)
    "m01-skip-team": ("mig", [(LOOP_FILTER, "       AND l.license_type <> 'team'\n" + LOOP_FILTER)], "k1"),
    "m02-skip-team-no-postcheck": ("mig", [(LOOP_FILTER, "       AND l.license_type <> 'team'\n" + LOOP_FILTER),
                                           (POSTCHECK, "")], "k1"),
    "m03-drop-not-exists": ("mig", [(LOOP_FILTER, "     ORDER BY l.user_id\n")], "k3"),
    "m04-only-active-memberships-count": ("mig", [(LOOP_FILTER,
        "       AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = l.user_id AND m.license_status = 'active')\n"
        "     ORDER BY l.user_id\n")], "k3"),
    "m05-handrolled-insert": ("mig", [(CALL, HANDROLLED)], "k2"),
    "m06-no-precheck": ("mig", [(PRECHECK, "")], "k5a"),
    "m07-no-early-return": ("mig", [("nothing to do';\n    RETURN;\n", "nothing to do';\n")], "k5b"),
    "m08-not-recorded": ("mig", [(RECORD, "")], "k1 k4b"),
    # Suspended exclusion (founder rule): each predicate appears in all three
    # cohort queries; the mutants remove it from all three (count 3).
    "m09a-drop-suspended-exclusion": ("mig", [(LIC_EXCL, "WHERE true", 3), (USR_EXCL, "", 3)], "k8"),
    "m09b-licence-status-only": ("mig", [(USR_EXCL, "", 3)], "k8"),
    "m09c-users-status-only": ("mig", [(LIC_EXCL, "WHERE true", 3)], "k8"),
    # Most likely wrong loop: log unexpected statuses and carry on.
    "m10-lenient-statuses": ("mig", [(BAD_RAISE, "")], "k7"),
    "r01-rollback-deletes-all-personal": ("rb", [(RB_DELETE, "   WHERE o.personal_owner_user_id IS NOT NULL;\n")], "k4b"),
    "r02-rollback-no-overrides-guard": ("rb", [(RB_OVERRIDES_COND, "                        AND false)\n")], "k4c"),
}


def apply(name, src_path, out_path):
    src = open(src_path).read()
    out = src
    for edit in MUTANTS[name][1]:
        old, new = edit[0], edit[1]
        want = edit[2] if len(edit) > 2 else 1
        n = out.count(old)
        if n != want:
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
        for k, (f, _, t) in MUTANTS.items():
            print(f"{k}|{f}|{t}")
    elif cmd == "apply":
        apply(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "classify":
        print(classify(sys.stdin.read().splitlines()))
    else:
        raise SystemExit("usage: mutants.py list|apply|classify")
