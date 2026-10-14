#!/usr/bin/env python3
"""BACKLOG-3938 / BACKLOG-3940 mutants of the two migration files.

Each mutant names the file it edits ('3938' or '3940') and a list of exact-string
edits. `apply` raises unless every pattern occurs exactly once (checked in order,
on the text as already edited), so a mutant that did not apply is never counted.
Each mutant is a plausible WRONG implementation; every d-control runs against it.

usage: mutants.py list                         -> name|file
       mutants.py apply <name> <in-file> <out-file>
       mutants.py classify < status-lines      -> INVALID | KILLED | SURVIVED
"""
import sys

G_OLD = "   WHERE user_id = user_uuid\n     AND user_uuid = (SELECT auth.uid())\n"
A_OLD = "    WHERE user_id = user_uuid\n    AND user_uuid = (SELECT auth.uid())\n"
MEM = "                  WHERE m.organization_id = p_org_id AND m.user_id = auth.uid())"
SUB_OLD = ("     AND NOT EXISTS (SELECT 1 FROM public.transaction_submissions s\n"
           "                      WHERE s.organization_id = p_org_id AND s.submitted_by = auth.uid()) THEN")
SUB_PRED = "WHERE s.organization_id = p_org_id AND s.submitted_by = auth.uid()) THEN"
IF_MEM = "  IF NOT EXISTS (SELECT 1 FROM public.organization_members m\n" + MEM + "\n"
USING = "  USING (public.has_internal_role((SELECT auth.uid())))\n"
CHECK = "  WITH CHECK (public.has_internal_role((SELECT auth.uid())));"
OM_ADMIN = "EXISTS (SELECT 1 FROM public.organization_members om WHERE om.user_id = (SELECT auth.uid()) AND om.role IN ('admin','super_admin'))"
DROP_READ = 'DROP POLICY IF EXISTS "Authenticated users can read links" ON public.support_ticket_backlog_links;\n'

MUTANTS = {
    # 3938: membership helpers
    "m1-no-guard-get_user_org_ids": ("3938", [(G_OLD, "   WHERE user_id = user_uuid\n")]),
    "m2-no-guard-is_org_admin": ("3938", [(A_OLD, "    WHERE user_id = user_uuid\n")]),
    "m3-guard-is-not-null-get_user_org_ids": ("3938", [(G_OLD, "   WHERE user_id = user_uuid\n     AND (SELECT auth.uid()) IS NOT NULL\n")]),
    "m3b-guard-is-not-null-is_org_admin": ("3938", [(A_OLD, "    WHERE user_id = user_uuid\n    AND (SELECT auth.uid()) IS NOT NULL\n")]),
    "s1-param-ignored-get_user_org_ids": ("3938", [(G_OLD, "   WHERE user_id = (SELECT auth.uid())\n")]),
    "s4-param-ignored-is_org_admin": ("3938", [(A_OLD, "    WHERE user_id = (SELECT auth.uid())\n")]),
    # 3938: broker_get_org_features
    "m4-bgof-member-only": ("3938", [(SUB_OLD, "     THEN")]),
    "m5-bgof-active-only": ("3938", [(MEM, MEM[:-1] + " AND public.member_status_grants_access(m.license_status))")]),
    "m6-bgof-via-is_org_admin": ("3938", [(IF_MEM, "  IF NOT public.is_org_admin(auth.uid(), p_org_id)\n")]),
    "m7-bgof-no-check": ("3938", [(IF_MEM, "  IF false AND NOT EXISTS (SELECT 1 FROM public.organization_members m\n" + MEM + "\n")]),
    "s2-bgof-no-org-predicate": ("3938", [(MEM, "                  WHERE m.user_id = auth.uid())")]),
    "s3-bgof-any-submission": ("3938", [(SUB_PRED, "WHERE s.organization_id = p_org_id) THEN")]),
    # 3940: links policy
    "n1-3940-with-check-old": ("3940", [(CHECK, "  WITH CHECK (" + OM_ADMIN + ");")]),
    "n2-3940-internal-or-admin": ("3940", [
        (USING, "  USING (public.has_internal_role((SELECT auth.uid())) OR " + OM_ADMIN + ")\n"),
        (CHECK, "  WITH CHECK (public.has_internal_role((SELECT auth.uid())) OR " + OM_ADMIN + ");")]),
    "n3-3940-keep-read": ("3940", [(DROP_READ, "")]),
    "n4-3940-to-public": ("3940", [("  FOR ALL TO authenticated\n", "  FOR ALL TO public\n")]),
}


def apply(name, src, dst):
    text = open(src).read()
    for old, new in MUTANTS[name][1]:
        n = text.count(old)
        if n != 1:
            raise SystemExit(f"mutant {name}: pattern matched {n} times (need 1): {old[:60]!r}")
        text = text.replace(old, new)
    open(dst, "w").write(text)


def classify(lines):
    lines = [l for l in lines if l.strip()]
    if not lines or any(l.startswith("ERROR|") and "0 checks" in l for l in lines):
        return "INVALID"
    return "KILLED" if any(l.startswith(("FAIL|", "ERROR|")) for l in lines) else "SURVIVED"


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "list":
        for k, (f, _) in MUTANTS.items():
            print(f"{k}|{f}")
    elif cmd == "apply":
        apply(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "classify":
        print(classify(sys.stdin.read().splitlines()))
