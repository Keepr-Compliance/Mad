#!/usr/bin/env python3
"""BACKLOG-3679 mutants: each is an exact-string replacement on the migration.
`apply` raises if the pattern does not occur exactly once, so a mutant that
did not apply can never be counted as survived.
usage: mutants.py list | mutants.py apply <name> <migration>"""
import sys

MUTANTS = {
    # name: (old, new, target controls)
    "m01-no-guard-trigger": (
        "CREATE TRIGGER guard_invite_acceptance\n  BEFORE UPDATE ON public.organization_members\n  FOR EACH ROW EXECUTE FUNCTION public.guard_invite_acceptance();",
        "-- trigger removed",
        "k04-invitee-attacks-refused k08-auth-users-stays-closed"),
    "m02-guard-skips-everyone": (
        "IF v_uid IS NOT NULL\n     AND public.is_org_admin(v_uid, OLD.organization_id)\n     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN",
        "IF true THEN",
        "k04-invitee-attacks-refused"),
    "m03-no-column-diff": (
        "     OR (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free)\n",
        "",
        "k04-invitee-attacks-refused"),
    "m04-guard-skips-authenticated": (
        "IF current_user NOT IN ('authenticated', 'anon') THEN",
        "IF current_user NOT IN ('anon') THEN",
        "k04-invitee-attacks-refused"),
    "m05-any-license-status": (
        "     OR (NEW.license_status IS DISTINCT FROM OLD.license_status AND NEW.license_status IS DISTINCT FROM 'active')\n",
        "",
        "k04-invitee-attacks-refused"),
    "m06-any-invitation-token": (
        "     OR (NEW.invitation_token IS DISTINCT FROM OLD.invitation_token AND NEW.invitation_token IS NOT NULL)\n",
        "",
        "k04-invitee-attacks-refused"),
    "m07-no-own-invite-select-policy": (
        "CREATE POLICY users_can_view_own_invite ON public.organization_members\n  FOR SELECT TO authenticated",
        "CREATE POLICY users_can_view_own_invite ON public.organization_members\n  FOR SELECT TO service_role",
        "k03-invitee-callback-accepts"),
    "m08-policy-reads-auth-users": (
        "    user_id IS NULL\n    AND invited_email IS NOT NULL\n    AND lower(btrim(invited_email)) = lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '')))\n    AND (invitation_expires_at IS NULL OR invitation_expires_at > now())\n  )\n  WITH CHECK",
        "    user_id IS NULL\n    AND invited_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())::text\n  )\n  WITH CHECK",
        "k02-admin-actions-work k08-auth-users-stays-closed"),
    "m09-no-expiry-on-accept": (
        "    AND (invitation_expires_at IS NULL OR invitation_expires_at > now())\n  )\n  WITH CHECK",
        "  )\n  WITH CHECK",
        "k06-expired-and-case"),
    "m10-no-expiry-on-view": (
        "    AND (invitation_expires_at IS NULL OR invitation_expires_at > now())\n  );\n\nCREATE OR REPLACE FUNCTION",
        "  );\n\nCREATE OR REPLACE FUNCTION",
        "k06-expired-and-case"),
    "m11-exact-case-email": (
        "  FOR UPDATE TO authenticated\n  USING (\n    user_id IS NULL\n    AND invited_email IS NOT NULL\n    AND lower(btrim(invited_email)) = lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '')))",
        "  FOR UPDATE TO authenticated\n  USING (\n    user_id IS NULL\n    AND invited_email IS NOT NULL\n    AND invited_email = (SELECT auth.jwt()) ->> 'email'",
        "k06-expired-and-case"),
    "m12-no-link-self-check": (
        "     OR NEW.user_id IS DISTINCT FROM v_uid\n",
        "",
        "k04-invitee-attacks-refused k05-other-user-refused"),
    "m13-guard-allows-claimed-rows": (
        "     OR OLD.user_id IS NOT NULL\n",
        "",
        "k03-invitee-callback-accepts"),
    "m14-guard-grants-execute": (
        "REVOKE EXECUTE ON FUNCTION public.guard_invite_acceptance() FROM PUBLIC, anon, authenticated;",
        "GRANT EXECUTE ON FUNCTION public.guard_invite_acceptance() TO authenticated;",
        "k08-auth-users-stays-closed"),
    "m15-policy-to-public": (
        "CREATE POLICY users_can_accept_invite ON public.organization_members\n  FOR UPDATE TO authenticated",
        "CREATE POLICY users_can_accept_invite ON public.organization_members\n  FOR UPDATE TO public",
        "k08-auth-users-stays-closed"),
    "m16-no-org-lock": (
        "  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN\n    RAISE EXCEPTION 'organization_id cannot be changed' USING ERRCODE = '42501';\n  END IF;\n",
        "",
        "k99-organization-unchanged"),
    "m17-admin-org-condition-dropped": (
        "     AND public.is_org_admin(v_uid, OLD.organization_id)\n     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN",
        "     AND public.is_org_admin(v_uid, OLD.organization_id) THEN",
        "k99-organization-unchanged"),
    "mA-guard-uses-NEW-org": (
        "public.is_org_admin(v_uid, OLD.organization_id)",
        "public.is_org_admin(v_uid, NEW.organization_id)",
        "k99-organization-unchanged k02-admin-actions-work"),
    "mB-withcheck-no-email": (
        "  WITH CHECK (\n    user_id = (SELECT auth.uid())\n    AND invited_email IS NOT NULL\n    AND lower(btrim(invited_email)) = lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '')))\n  );",
        "  WITH CHECK (\n    user_id = (SELECT auth.uid())\n  );",
        "k99-organization-unchanged k04-invitee-attacks-refused k05-other-user-refused"),
    # compound: the layers under each single mutant above, removed together
    "c18-no-org-lock+no-admin-org-condition": (
        ["m16-no-org-lock", "m17-admin-org-condition-dropped"],
        "k99-organization-unchanged"),
    "c19-A+no-org-lock+no-admin-org-condition": (
        ["m16-no-org-lock", "m17-admin-org-condition-dropped", "mA-guard-uses-NEW-org"],
        "k99-organization-unchanged"),
    "m21-guard-frees-invited-email": (
        "v_free text[] := ARRAY['user_id', 'joined_at', 'license_status', 'invitation_token', 'updated_at'];",
        "v_free text[] := ARRAY['user_id', 'joined_at', 'license_status', 'invitation_token', 'updated_at', 'invited_email'];",
        "k04-invitee-attacks-refused"),
    "c20-B+guard-frees-invited-email": (
        ["mB-withcheck-no-email", "m21-guard-frees-invited-email"],
        "k04-invitee-attacks-refused"),
}

def pairs(name):
    v = MUTANTS[name]
    if isinstance(v[0], list):          # compound: ([names...], targets)
        out = []
        for part in v[0]:
            out += pairs(part)
        return out
    return [(v[0], v[1])]


def main():
    if sys.argv[1] == "list":
        for k, v in MUTANTS.items():
            print(f"{k}|{v[-1]}")
        return
    if sys.argv[1] == "apply":
        name, path = sys.argv[2], sys.argv[3]
        src = open(path).read()
        for old, new in pairs(name):
            n = src.count(old)
            if n != 1:
                raise SystemExit(f"MUTATION NOT APPLIED: {name} pattern occurs {n} times")
            src = src.replace(old, new)
        sys.stdout.write(src)
        return
    raise SystemExit(__doc__)

if __name__ == "__main__":
    main()
