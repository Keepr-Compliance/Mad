#!/usr/bin/env python3
"""BACKLOG-3917 mutants of 20261014100000_backlog_3917_member_status_allow_list.sql.

Each mutant is a list of exact-string edits. `apply` raises unless every
pattern occurs exactly once (checked in order, on the text as already edited),
so a mutant that did not apply can never be counted.

Targets name control files in ../controls (without .sql). Mutants whose only
killer is the catalogue control c09 are the policies that stay closed through
another table's policy while the function changes stand (SR R1); they list
their behavioural control too, so the run shows that control staying green.

usage: mutants.py list                      -> name|expected|targets
       mutants.py apply <name> <migration> <out-migration>
       mutants.py classify < status-lines   -> INVALID | KILLED | SURVIVED
"""
import sys

H = "public.member_status_grants_access"


def drop(alias, indent):
    """Remove the helper call on <alias>.license_status (the line before it keeps its text)."""
    return (f"\n{indent}AND {H}({alias}.license_status)", "")


D1 = ("    AND role IN ('admin', 'it_admin')\n    AND " + H + "(license_status)\n",
      "    AND role IN ('admin', 'it_admin')\n")
D2 = drop("om", "       ")
D5 = ("   WHERE user_id = user_uuid\n     AND " + H + "(license_status);", "   WHERE user_id = user_uuid;")
D3 = ("              AND " + H + "(m.license_status)\n              AND (m.role IN",
      "              AND (m.role IN")
D4 = ("              AND " + H + "(m.license_status)\n         )", "         )")
P1 = drop("org_admin", "       ")
P2U = drop("reviewer_using", "             ")
P2C = drop("reviewer_check", "             ")
P3 = drop("commenter", "                  ")
P4A = drop("comment_reader", "                  ")
P4B = drop("internal_reader", "                 ")
P5 = drop("submitter", "         ")
P6 = drop("uploader", "         ")
P7 = drop("colleague_org", "                  ")
R4_TOKEN = drop("token_manager", "       ")
R4_IDP_VIEW = drop("idp_viewer", "       ")
R4_IDP_MANAGE = drop("idp_manager", "       ")
R4_LOG = drop("log_viewer", "       ")
HELPER = "  SELECT COALESCE(p_license_status IN ('active'), false);"
LAST = "       AND " + H + "(log_viewer.license_status)));\n"
ORG_SELECT_FILTERED = LAST + ("\nALTER POLICY organizations_select_public ON public.organizations\n"
                              "  USING (id IN (SELECT public.get_user_org_ids((SELECT auth.uid()))));\n")

ALL_READS_WRITES = "c01-member-writes c02-org-settings c03-review-writes c04-reads c06-checklist-templates c07-agent-upload c08-identity-scim"

MUTANTS = {
    # name: (expected, [(old, new), ...], targets)
    "m01-is-org-admin-reverted": ("kill", [D1], "c01-member-writes"),
    "m02-can-review-submission-reverted": ("kill", [D2], "c03-review-writes c04-reads"),
    "m03-review-function-and-inline-policies-reverted": ("kill", [D2, P2U, P2C, P3, P4A, P4B], "c03-review-writes c04-reads"),
    "m04-update-policy-both-branches-removed": ("kill", [P2U, P2C], "c03-review-writes c09-catalog"),
    "m05-update-policy-using-removed": ("kill", [P2U], "c03-review-writes c09-catalog"),
    "m06-comment-insert-removed": ("kill", [P3], "c03-review-writes c09-catalog"),
    "m07-comment-read-both-branches-removed": ("kill", [P4A, P4B], "c04-reads c09-catalog"),
    "m08-get-user-org-ids-reverted": ("kill", [D5], "c04-reads"),
    "m09-get-user-org-ids-and-users-policy-reverted": ("kill", [D5, P7], "c04-reads"),
    "m10-users-policy-removed": ("kill", [P7], "c04-reads c09-catalog"),
    "m11-org-settings-policy-removed": ("kill", [P1], "c02-org-settings"),
    "m12-edit-templates-reverted": ("kill", [D3], "c06-checklist-templates"),
    "m13-own-templates-reverted": ("kill", [D4], "c06-checklist-templates"),
    "m14-submission-insert-policy-removed": ("kill", [P5], "c07-agent-upload"),
    "m15-storage-upload-policy-removed": ("kill", [P6], "c07-agent-upload"),
    "m16-deny-list-helper": ("kill", [(HELPER, "  SELECT COALESCE(p_license_status <> 'suspended', false);")], ALL_READS_WRITES),
    "m17-helper-allows-every-status": ("kill", [(HELPER, "  SELECT true;")], "c01-member-writes c09-catalog"),
    "m18-helper-null-grants": ("kill", [(HELPER, "  SELECT COALESCE(p_license_status IN ('active'), true);")], "c09-catalog"),
    # Default privileges grant anon EXECUTE on a new function, so dropping anon from
    # the GRANT alone changes nothing; the wrong build is a REVOKE that names anon.
    "m19-helper-not-executable-by-anon": ("kill", [("(text) FROM PUBLIC;", "(text) FROM PUBLIC, anon;"),
                                                   ("TO anon, authenticated, service_role;", "TO authenticated, service_role;")],
                                          "c12-signed-out c09-catalog"),
    "m20-is-org-admin-only": ("kill", [D2, D5, D3, D4, P1, P2U, P2C, P3, P4A, P4B, P5, P6, P7], "c02-org-settings c03-review-writes c04-reads c06-checklist-templates c07-agent-upload"),
    "m21-scim-token-policy-without-status": ("kill", [R4_TOKEN], "c08-identity-scim"),
    "m22-idp-view-policy-without-status": ("kill", [R4_IDP_VIEW], "c08-identity-scim"),
    "m23-idp-manage-policy-without-status": ("kill", [R4_IDP_MANAGE], "c09-catalog"),
    "m24-scim-log-policy-without-status": ("kill", [R4_LOG], "c08-identity-scim"),
    "m25-organizations-select-filtered": ("kill", [(LAST, ORG_SELECT_FILTERED)], "c04-reads c09-catalog"),
}


def classify(lines):
    status = [l.split("|", 1)[0] for l in lines if l.split("|", 1)[0] in ("PASS", "FAIL", "ERROR")]
    if not status or "ERROR" in status:
        return "INVALID"
    if "FAIL" in status:
        return "KILLED"
    return "SURVIVED"


def apply(name, src, dst):
    text = open(src).read()
    for old, new in MUTANTS[name][1]:
        n = text.count(old)
        if n != 1:
            raise SystemExit(f"mutant {name}: pattern occurs {n} times, expected 1: {old[:70]!r}")
        text = text.replace(old, new)
    open(dst, "w").write(text)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "list":
        for k, (exp, _, targets) in MUTANTS.items():
            print(f"{k}|{exp}|{targets}")
    elif cmd == "apply":
        apply(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "classify":
        print(classify(sys.stdin.read().splitlines()))
    else:
        raise SystemExit("usage: mutants.py list|apply|classify")
