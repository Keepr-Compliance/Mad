#!/usr/bin/env python3
"""BACKLOG-3857 mutants.

Kinds:
  - edit:    exact-string replacement on the migration.
  - rbedit:  exact-string replacement on rollback-3857.sql.
`apply` raises unless the pattern occurs exactly once, so a mutant that did not
apply can never be counted.

usage: mutants.py list
       mutants.py apply <name> <migration> <rollback> <out-migration> <out-rollback>
       mutants.py classify < status-lines

classify: INVALID (any ERROR, or no status line), KILLED (no ERROR, >=1 FAIL),
SURVIVED (only PASS).
"""
import sys

GUARD = ("  IF p_changes->>'license_type' = 'trial' THEN\n"
         "    RAISE EXCEPTION 'license_type trial is no longer accepted' USING ERRCODE = '22023';\n"
         "  END IF;\n")
PRE_TRIAL = ("  IF EXISTS (SELECT 1 FROM public.licenses WHERE license_type = 'trial') THEN\n"
             "    RAISE EXCEPTION '3857 pre-check: % licenses row(s) have license_type trial',\n"
             "      (SELECT count(*) FROM public.licenses WHERE license_type = 'trial');\n"
             "  END IF;\n")
NEW_CHECK = "  CHECK (license_type = ANY (ARRAY['individual'::text, 'team'::text]));\n"
OLD_CHECK = "  CHECK (license_type = ANY (ARRAY['trial'::text, 'individual'::text, 'team'::text]));\n"

MUTANTS = {
    # name: (kind, old, new, target controls)
    # the likely wrong implementation: CHECK only, no RPC guard (raises 23514, not 22023)
    "m01-no-rpc-guard": ("edit", GUARD, "", "c2-rpc-refuses-trial"),
    "m02-check-keeps-trial": ("edit", NEW_CHECK, OLD_CHECK, "c3-raw-writes"),
    "m03a-license_type-default-kept": ("edit",
        "ALTER TABLE public.licenses ALTER COLUMN license_type SET DEFAULT 'individual';\n", "", "c4-defaults"),
    "m03b-trial_status-default-kept": ("edit",
        "ALTER TABLE public.licenses ALTER COLUMN trial_status DROP DEFAULT;\n", "", "c4-defaults"),
    "m03c-trial_started_at-default-kept": ("edit",
        "ALTER TABLE public.licenses ALTER COLUMN trial_started_at DROP DEFAULT;\n", "", "c4-defaults"),
    "m03d-trial_expires_at-default-kept": ("edit",
        "ALTER TABLE public.licenses ALTER COLUMN trial_expires_at DROP DEFAULT;\n", "", "c4-defaults"),
    # over-broad guard: refuses every license_type change
    "m04a-guard-refuses-any-type-change": ("edit",
        "  IF p_changes->>'license_type' = 'trial' THEN\n", "  IF p_changes ? 'license_type' THEN\n",
        "c5-rpc-still-works"),
    "m04b-type-update-dropped": ("edit",
        "UPDATE public.licenses SET license_type = (p_changes->>'license_type'), updated_at = NOW() WHERE id = p_license_id;",
        "UPDATE public.licenses SET updated_at = NOW() WHERE id = p_license_id;", "c5-rpc-still-works"),
    "m05-no-trial-precheck": ("edit", PRE_TRIAL, "", "c6-seed-trial-aborts"),
    # the DROP no longer matches the name the ADD creates, so a second apply
    # fails with "already exists"
    "m06a-not-rerunnable-constraint": ("edit",
        "ALTER TABLE public.licenses ADD CONSTRAINT licenses_license_type_check\n",
        "ALTER TABLE public.licenses ADD CONSTRAINT licenses_license_type_check_v2\n",
        "c7-apply-twice"),
    "m06b-precheck-rejects-applied-body": ("edit",
        "v_md5 NOT IN ('7e27a1d38e49eec91def8d2cc584bf3e', 'ab793576ab168fec56e30d428cfc0514')",
        "v_md5 NOT IN ('7e27a1d38e49eec91def8d2cc584bf3e')", "c7-apply-twice"),
    "m06c-acl-changed": ("edit",
        "$fn$;\n", "$fn$;\nREVOKE EXECUTE ON FUNCTION public.admin_update_license(uuid, jsonb) FROM anon;\n",
        "c7-apply-twice"),
    "m07-precheck-ignores-body": ("edit",
        "  IF v_md5 IS NULL OR v_md5 NOT IN", "  IF false AND v_md5 NOT IN", "c9-drift-aborts"),
    "r01-rollback-keeps-new-check": ("rbedit", OLD_CHECK, NEW_CHECK, "c8-rollback"),
    "r02-rollback-forgets-trial_status-default": ("rbedit",
        "ALTER TABLE public.licenses ALTER COLUMN trial_status SET DEFAULT 'active'::text;\n", "", "c8-rollback"),
    "r03-rollback-keeps-guard": ("rbedit",
        "    RAISE EXCEPTION 'Unauthorized';\n  END IF;\n",
        "    RAISE EXCEPTION 'Unauthorized';\n  END IF;\n\n" + GUARD, "c8-rollback"),
}


def classify(lines):
    status = [l.split("|", 1)[0] for l in lines if l.split("|", 1)[0] in ("PASS", "FAIL", "ERROR")]
    if not status or "ERROR" in status:
        return "INVALID"
    if "FAIL" in status:
        return "KILLED"
    return "SURVIVED"


def main():
    if sys.argv[1] == "classify":
        print(classify(sys.stdin.read().splitlines()))
        return
    if sys.argv[1] == "list":
        for k, v in MUTANTS.items():
            print(f"{k}|{v[-1]}")
        return
    if sys.argv[1] != "apply":
        raise SystemExit(__doc__)
    name, mig, rb, out_mig, out_rb = sys.argv[2:7]
    kind, a, b, _targets = MUTANTS[name]
    srcs = {"edit": open(mig).read(), "rbedit": open(rb).read()}
    n = srcs[kind].count(a)
    if n != 1:
        raise SystemExit(f"mutant {name}: pattern occurs {n} times (need exactly 1)")
    srcs[kind] = srcs[kind].replace(a, b)
    open(out_mig, "w").write(srcs["edit"])
    open(out_rb, "w").write(srcs["rbedit"])


if __name__ == "__main__":
    main()
