#!/usr/bin/env python3
"""BACKLOG-3851 setup mutants of supabase/migrations/20261016054316_backlog_3851_setup_completes_invite.sql.
Each edit is an exact-string replace that must match exactly once, else the mutant is
INVALID (exit 1). `list` prints name|control fragment ('race:<scenario>' = race.sh).
`apply <name> <src> <dst>` writes the mutant and prints MUTATION APPLIED plus each new line.

The precondition md5 is part of the file, not of prosrc, so a mutated body still passes
the DO $pre$ guard on a venue holding the production body.
"""
import sys

ORG_INSERT = """  INSERT INTO organizations (name, slug, microsoft_tenant_id, plan, max_seats)
  VALUES (p_org_name, p_org_slug, p_tenant_id, 'trial', 10)
  ON CONFLICT (microsoft_tenant_id) DO NOTHING;

"""
CLAIM = """  IF v_is_invite THEN
    UPDATE organization_members
    SET user_id = v_user_id,
        license_status = 'active',
        joined_at = NOW(),
        invitation_token = NULL
    WHERE id = v_member_id
      AND user_id IS NULL;
  END IF;
"""
USERS_IF = """  IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_user_id) THEN
    INSERT INTO users (id, email, oauth_provider, oauth_id)
    VALUES (v_user_id, v_user_email, 'azure', v_oauth_id);
  END IF;
"""
BIND_TRY = """      BEGIN
        UPDATE organizations SET microsoft_tenant_id = p_tenant_id WHERE id = v_org_id;
      EXCEPTION WHEN unique_violation THEN
        RETURN jsonb_build_object('success', false, 'error', 'tenant_in_use');
      END;
"""
INACTIVE = """    IF v_status IS DISTINCT FROM 'active' THEN
      RETURN jsonb_build_object('success', false, 'error', 'membership_inactive');
    END IF;
"""

MUTANTS = {
  # name: (control fragment, [(old, new), ...])
  "X1_org_insert_restored": ("s01", [("  -- Target a: the caller's first brokerage membership, any status.\n",
                                      ORG_INSERT + "  -- Target a: the caller's first brokerage membership, any status.\n")]),
  "X2_bind_any_role":       ("s06", [("  IF v_role IN ('admin', 'it_admin') THEN\n", "  IF true THEN\n")]),
  "X3_no_expiry":           ("s08", [("      AND (m.invitation_expires_at IS NULL OR m.invitation_expires_at > now())\n", "")]),
  "X4_metadata_email":      ("s10", [("    lower(btrim(email)),\n",
                                      "    lower(btrim(COALESCE(email, raw_user_meta_data->>'email', raw_user_meta_data->>'mail', raw_user_meta_data->>'preferred_username'))),\n")]),
  "X5_claim_before_check":  ("s04", [("  IF v_role IN ('admin', 'it_admin') THEN\n",
                                      CLAIM + "\n  IF v_role IN ('admin', 'it_admin') THEN\n")]),
  "X6_no_unique_handler":   ("race:s14", [(BIND_TRY, "      UPDATE organizations SET microsoft_tenant_id = p_tenant_id WHERE id = v_org_id;\n")]),
  "X7_no_inactive_check":   ("s19", [(INACTIVE, "    NULL;\n")]),
  "X7b_ne_active":          ("s19", [("    IF v_status IS DISTINCT FROM 'active' THEN\n", "    IF v_status <> 'active' THEN\n")]),
  "X8_case_sensitive_held": ("s20", [("        WHERE lower(o.microsoft_tenant_id) = p_tenant_id\n", "        WHERE o.microsoft_tenant_id = p_tenant_id\n")]),
  "X9_users_insert_always": ("s18", [(USERS_IF, "  INSERT INTO users (id, email, oauth_provider, oauth_id)\n  VALUES (v_user_id, v_match_email, 'azure', v_oauth_id)\n  ON CONFLICT (id) DO NOTHING;\n")]),
  "X10_no_personal_filter": ("s15", [("  WHERE m.user_id = v_user_id\n    AND o.personal_owner_user_id IS NULL\n", "  WHERE m.user_id = v_user_id\n")]),
}

def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "list":
        for n, (want, _) in MUTANTS.items():
            print(f"{n}|{want}")
        return 0
    if len(sys.argv) == 5 and sys.argv[1] == "apply":
        name, src, dst = sys.argv[2:5]
        if name not in MUTANTS:
            print(f"unknown mutant {name}", file=sys.stderr); return 1
        s = open(src).read()
        for old, new in MUTANTS[name][1]:
            n = s.count(old)
            if n != 1:
                print(f"INVALID|{name}|pattern matched {n} times (need exactly 1): {old[:60]!r}", file=sys.stderr); return 1
            s = s.replace(old, new)
        open(dst, "w").write(s)
        print(f"MUTATION APPLIED|{name}|{len(MUTANTS[name][1])} edit(s)")
        for _, new in MUTANTS[name][1]:
            print("   new: " + (new.strip().splitlines() or ["<removed>"])[0][:140])
        return 0
    print(__doc__); return 2

if __name__ == "__main__":
    sys.exit(main())
