#!/usr/bin/env python3
"""BACKLOG-3843 mutants of 20261010100000_backlog_3843_org_member_client_write_lockdown.sql.

Each mutant is a list of exact-string edits. `apply` raises unless every
pattern occurs exactly once (checked in order, on the text as already edited),
so a mutant that did not apply can never be counted.

Targets name control files: controls/<name>.sql here, else ../backlog-3538 or
../backlog-3679.

usage: mutants.py list                      -> name|expected|targets
       mutants.py apply <name> <migration> <out-migration>
       mutants.py classify < status-lines   -> INVALID | KILLED | SURVIVED
"""
import sys

ORG_TRIGGER = ("CREATE TRIGGER guard_organization_client_update\n"
               "  BEFORE UPDATE ON public.organizations\n"
               "  FOR EACH ROW EXECUTE FUNCTION public.guard_organization_client_update();")
ORG_FREE = ("ARRAY['retention_years', 'jit_provisioning_enabled',\n"
            "                         'graph_admin_consent_granted', 'graph_admin_consent_at',\n"
            "                         'updated_at']")
ORG_EXEMPT = ("  IF current_user NOT IN ('authenticated', 'anon') THEN\n    RETURN NEW;\n  END IF;\n\n"
              "  -- Compared by value")
MEM_EXEMPT = ("  IF current_user NOT IN ('authenticated', 'anon') THEN\n    RETURN NEW;\n  END IF;\n\n"
              "  -- INSERT: the row-level")
INTERNAL = "  IF public.has_internal_role(auth.uid()) THEN\n    RETURN NEW;\n  END IF;\n\n"
ADMIN_CHECK = ("    IF (to_jsonb(NEW) - v_admin_free) IS DISTINCT FROM (to_jsonb(OLD) - v_admin_free) THEN\n"
               "      RAISE EXCEPTION 'Only the role or invitation can be changed from a client session'\n"
               "        USING ERRCODE = '42501';\n"
               "    END IF;\n")
LOCKED17 = ("id, name, slug, plan, max_seats, settings, created_at, sso_enabled, sso_required, "
            "sso_domain_restriction, scim_enabled, default_member_role, directory_sync_enabled, "
            "directory_sync_last_at, microsoft_tenant_id, google_domain, personal_owner_user_id")

MUTANTS = {
    # name: (expected, [(old, new), ...], targets)
    "n01-no-org-trigger": ("kill", [(ORG_TRIGGER, "-- (no trigger)")],
                           "k21-org-locked-column k22-org-sweep"),
    "n02-column-revoke-instead-of-trigger": ("kill", [(ORG_TRIGGER,
        "REVOKE UPDATE (" + LOCKED17 + ") ON public.organizations FROM authenticated, anon;")],
        "k21-org-locked-column k22-org-sweep"),
    "n03-one-more-allowed-column": ("kill", [(ORG_FREE, ORG_FREE.replace("'updated_at']", "'updated_at', 'sso_required']"))],
                                    "k22-org-sweep"),
    "n04-empty-org-allow-list": ("kill", [(ORG_FREE, "ARRAY[]::text[]")], "k23-org-allowed-columns"),
    "n05-org-exempt-by-auth-role": ("kill", [(ORG_EXEMPT, ORG_EXEMPT.replace(
        "current_user NOT IN ('authenticated', 'anon')", "coalesce(auth.role(), '') = 'service_role'"))],
        "k24-definer-and-service"),
    "n06-member-exempt-by-auth-role": ("kill", [(MEM_EXEMPT, MEM_EXEMPT.replace(
        "current_user NOT IN ('authenticated', 'anon')", "coalesce(auth.role(), '') = 'service_role'"))],
        "k24-definer-and-service k07-definer-and-service-paths"),
    "n07-org-internal-role-exempt": ("kill", [(ORG_EXEMPT, ORG_EXEMPT.replace("  -- Compared by value", INTERNAL + "  -- Compared by value"))],
                                     "k25-internal-role-not-exempt"),
    "n08-member-internal-role-exempt": ("kill", [(MEM_EXEMPT, MEM_EXEMPT.replace("  -- INSERT: the row-level", INTERNAL + "  -- INSERT: the row-level"))],
                                        "k25-internal-role-not-exempt"),
    "n09-old-admin-branch": ("kill", [(ADMIN_CHECK, "")], "k26-admin-member-locked-columns"),
    "n10-license-status-admin-writable": ("kill", [("ARRAY['role', 'invitation_token', 'invitation_expires_at', 'updated_at']",
                                                    "ARRAY['role', 'license_status', 'invitation_token', 'invitation_expires_at', 'updated_at']")],
                                          "k26-admin-member-locked-columns"),
    "n11-role-not-admin-writable": ("kill", [("ARRAY['role', 'invitation_token',", "ARRAY['invitation_token',")],
                                    "k27-admin-allowed-member-writes"),
    "n12-expiry-not-admin-writable": ("kill", [("'invitation_token', 'invitation_expires_at', 'updated_at']", "'invitation_token', 'updated_at']")],
                                      "k27-admin-allowed-member-writes"),
    "n13-claim-any-status": ("kill", [("     OR OLD.license_status IS DISTINCT FROM 'pending'\n", "")], "k28-invitee-claim"),
    "n14-update-only-trigger": ("kill", [("BEFORE INSERT OR UPDATE ON public.organization_members", "BEFORE UPDATE ON public.organization_members")],
                                "k29-member-insert k25-internal-role-not-exempt"),
    "n15-insert-allows-user-id": ("kill", [("       OR NEW.user_id IS NOT NULL\n", "")], "k29-member-insert"),
    "n16-insert-allows-active": ("kill", [("       OR NEW.license_status IS DISTINCT FROM 'pending'\n", "")], "k29-member-insert"),
    "n17-insert-any-inviter": ("kill", [("       OR NEW.invited_by IS DISTINCT FROM v_uid\n", "")], "k29-member-insert"),
    "n18-no-seat-limit": ("kill", [("      IF v_used >= v_max_seats THEN", "      IF false THEN")], "k29-member-insert"),
    "n19-seat-limit-off-by-one": ("kill", [("      IF v_used >= v_max_seats THEN", "      IF v_used > v_max_seats THEN")], "k29-member-insert"),
    "n20-insert-allows-joined-at": ("kill", [("       OR NEW.joined_at IS NOT NULL\n", "")], "k29-member-insert"),
    "n21-insert-any-provenance": ("kill", [("       OR NEW.provisioned_by IS DISTINCT FROM 'invite'\n", ""),
                                           ("       OR NEW.scim_synced_at IS NOT NULL\n", "")], "k29-member-insert"),
    "n22-joined-at-not-pinned": ("kill", [("  NEW.joined_at := now();\n", "")], "k28-invitee-claim k11-accept-pins-joined-at"),
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
            raise SystemExit(f"mutant {name}: pattern occurs {n} times, expected 1: {old[:60]!r}")
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
