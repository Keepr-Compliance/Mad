#!/usr/bin/env python3
"""BACKLOG-3759 mutants.

Kinds:
  - edit:    exact-string replacement on the migration.
  - rbedit:  exact-string replacement on rollback-3759.sql.
`apply` raises unless the pattern occurs exactly once, so a mutant that did not
apply can never be counted.

usage: mutants.py list
       mutants.py apply <name> <migration> <rollback> <out-migration> <out-rollback>
       mutants.py classify < status-lines

classify reads the PASS|/FAIL|/ERROR| lines of every target control run
against one mutant and prints its verdict:
  INVALID   any ERROR line, or no status line at all: the run proved nothing
  KILLED    no ERROR and at least one FAIL: a control's assertion saw the mutant
  SURVIVED  only PASS lines

Known vacuous, deliberately NOT listed: dropping only the
`GRANT ... can_edit_checklist_templates(uuid) TO authenticated, service_role`
line. Both roles already hold EXECUTE, so nothing can go red.
"""
import sys

A_TS = "ALTER POLICY transaction_submissions_select_public ON public.transaction_submissions TO authenticated;\n"
A_MSG = "ALTER POLICY message_access_via_submission ON public.submission_messages TO authenticated;\n"
A_ATT = "ALTER POLICY attachment_access_via_submission ON public.submission_attachments TO authenticated;\n"
REV_CRS = "REVOKE EXECUTE ON FUNCTION public.can_review_submission(uuid) FROM PUBLIC, anon;\n"
GR_CRS = "GRANT EXECUTE ON FUNCTION public.can_review_submission(uuid) TO authenticated, service_role;\n"
REV_CET = "REVOKE EXECUTE ON FUNCTION public.can_edit_checklist_templates(uuid) FROM PUBLIC, anon;\n"
GR_CET = "GRANT EXECUTE ON FUNCTION public.can_edit_checklist_templates(uuid) TO authenticated, service_role;\n"

MUTANTS = {
    # name: (kind, old, new, target controls)
    # the likely wrong implementation: option A, revoke only
    "m01-revoke-only": ("edit", A_TS + A_MSG + A_ATT, "", "c2-anon-reads"),
    "m02-only-submissions-rule": ("edit", A_MSG + A_ATT, "", "c2-anon-reads"),
    "m03-revoke-omits-anon": ("edit", REV_CRS,
        "REVOKE EXECUTE ON FUNCTION public.can_review_submission(uuid) FROM PUBLIC;\n", "c1-grants"),
    "m04a-review-check-off-for-authenticated": ("edit", REV_CRS + GR_CRS,
        "REVOKE EXECUTE ON FUNCTION public.can_review_submission(uuid) FROM PUBLIC, anon, authenticated;\n"
        "GRANT EXECUTE ON FUNCTION public.can_review_submission(uuid) TO service_role;\n",
        "c3-signed-in-reads c4-nested-writes c5-reviewer-update"),
    "m04b-template-check-off-for-authenticated": ("edit", REV_CET + GR_CET,
        "REVOKE EXECUTE ON FUNCTION public.can_edit_checklist_templates(uuid) FROM PUBLIC, anon, authenticated;\n"
        "GRANT EXECUTE ON FUNCTION public.can_edit_checklist_templates(uuid) TO service_role;\n",
        "c6-checklist-callers"),
    "m05-service-role-revoked": ("edit", REV_CRS + GR_CRS,
        "REVOKE EXECUTE ON FUNCTION public.can_review_submission(uuid) FROM PUBLIC, anon, service_role;\n"
        "GRANT EXECUTE ON FUNCTION public.can_review_submission(uuid) TO authenticated;\n",
        "c1-grants"),
    # DROP + CREATE restating the rule without the reviewer branch
    "m06-drop-create-restated": ("edit", A_TS,
        "DROP POLICY transaction_submissions_select_public ON public.transaction_submissions;\n"
        "CREATE POLICY transaction_submissions_select_public ON public.transaction_submissions FOR SELECT TO authenticated\n"
        "  USING (submitted_by = (SELECT auth.uid()));\n",
        "c3-signed-in-reads c1-grants"),
    "m07-precheck-rejects-applied-state": ("edit",
        "    IF v_roles NOT IN ('{public}', '{authenticated}') THEN\n",
        "    IF v_roles NOT IN ('{public}') THEN\n", "c7-apply-twice"),
    "m08-precheck-ignores-using": ("edit",
        "    IF v_md5 IS DISTINCT FROM r.expected_md5 THEN\n",
        "    IF false THEN\n", "c9-drift-aborts"),
    "r01-rollback-keeps-anon-revoked": ("rbedit",
        "GRANT EXECUTE ON FUNCTION public.can_review_submission(uuid) TO anon;\n", "", "c8-rollback"),
    "r02-rollback-misses-messages-rule": ("rbedit",
        "ALTER POLICY message_access_via_submission ON public.submission_messages TO public;\n", "", "c8-rollback"),
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
