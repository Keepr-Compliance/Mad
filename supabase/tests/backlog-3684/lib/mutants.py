"""BACKLOG-3684 mutants. Each is an exact-once replacement in file A or B; each must turn
the named control red.  list -> name|part|control ; apply <name> <src> <dst>."""
import sys

A_EMAIL = """  IF v_match_email IS NULL OR v_match_email = ''
     OR v_match_email IS DISTINCT FROM lower(btrim(v_invited_email)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'email_mismatch');
  END IF;
"""
A_CLAIM = """  UPDATE organization_members
  SET user_id = v_user_id,
      license_status = 'active',
      joined_at = NOW(),
      invitation_token = NULL
  WHERE id = v_member_id
    AND user_id IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows <> 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_invite');
  END IF;
"""
A_BIND = """  IF v_identity_tid IS NOT NULL AND v_role IN ('admin', 'it_admin') THEN
    v_bind_error := public._invite_bind_tenant(v_org_id, v_identity_tid);"""

M = {
  # wrong build 1: token-only (the email check removed)
  'token_only': ('A', 't02', [(A_EMAIL, '')]),
  'token_only_t04b': ('A', 't04', [(A_EMAIL, '')]),
  # token OR email lookup
  'token_or_email': ('A', 't03', [("  WHERE m.invitation_token = p_token\n",
      "  WHERE (m.invitation_token = p_token OR lower(btrim(m.invited_email)) = (SELECT lower(btrim(email)) FROM auth.users WHERE id = v_user_id))\n")]),
  'no_expiry': ('A', 't06', [("  IF v_expires_at IS NOT NULL AND v_expires_at <= now() THEN", "  IF false THEN")]),
  'expiry_lt': ('A', 't06', [("v_expires_at <= now() THEN", "v_expires_at < now() THEN")]),
  'metadata_email': ('A', 't07', [("    lower(btrim(email)),\n    COALESCE(", "    lower(btrim(COALESCE(email, raw_user_meta_data->>'email'))),\n    COALESCE(")]),
  'no_already_placed': ('A', 't10', [("    RETURN jsonb_build_object('success', false, 'error', 'already_placed');", "    NULL;")]),
  'no_personal_filter': ('A', 't11', [("    AND m.license_status = 'pending'\n    AND o.personal_owner_user_id IS NULL\n  LIMIT 1\n  FOR UPDATE OF m;",
      "    AND m.license_status = 'pending'\n  LIMIT 1\n  FOR UPDATE OF m;")]),
  'no_token_clear': ('A', 't01', [("      joined_at = NOW(),\n      invitation_token = NULL\n  WHERE id = v_member_id", "      joined_at = NOW()\n  WHERE id = v_member_id")]),
  # wrong build 6: claim, then bind
  'claim_then_bind': ('A', 't08', [(A_CLAIM, ''), (A_BIND, A_CLAIM + "\n" + A_BIND)]),
  'no_identity_check': ('A', 't08', [("    IF v_identity_tid IS NULL THEN\n      RAISE EXCEPTION 'tenant does not match the signed-in identity' USING ERRCODE = '42501';\n    END IF;\n\n    IF v_identity_tid = '9188",
      "    IF v_identity_tid IS NULL THEN\n      v_identity_tid := lower(btrim(p_tenant_id));\n    END IF;\n\n    IF v_identity_tid = '9188")]),
  # wrong build 3: new functions without REVOKE anon
  'accept_no_revoke': ('A', 't09', [("REVOKE ALL ON FUNCTION public.accept_invitation(text, text) FROM PUBLIC, anon;\n", "")]),
  'detect_no_revoke': ('A', 't09', [("REVOKE ALL ON FUNCTION public.caller_has_pending_invite() FROM PUBLIC, anon;\n", "")]),
  'bind_client_grant': ('A', 't09', [("REVOKE ALL ON FUNCTION public._invite_bind_tenant(uuid, text) FROM PUBLIC, anon, authenticated;", "REVOKE ALL ON FUNCTION public._invite_bind_tenant(uuid, text) FROM PUBLIC, anon;")]),
  # wrong build 4: detector ignores the email
  'detect_no_email': ('A', 't02', [("      AND lower(btrim(m.invited_email)) = lower(btrim(u.email))\n", "")]),
  # control 12: detector ignores expiry
  'detect_no_expiry': ('A', 't06', [("      AND (m.invitation_expires_at IS NULL OR m.invitation_expires_at > now())\n  )", "  )")]),
  'detect_no_personal_filter': ('A', 't11', [("      AND m.invitation_token IS NOT NULL\n      AND o.personal_owner_user_id IS NULL\n", "      AND m.invitation_token IS NOT NULL\n")]),
  # wrong build 5 (DB): an email path left in place
  'b_skip_auto_provision': ('B', 't12', [("CREATE OR REPLACE FUNCTION public.auto_provision_it_admin(", "CREATE OR REPLACE FUNCTION pg_temp.auto_provision_it_admin_unused(")]),
  'b_skip_claim_revoke': ('B', 't13', [("REVOKE EXECUTE ON FUNCTION public.claim_pending_invite() FROM authenticated;\n", "")]),
  'b_skip_accept_policy': ('B', 't13', [("ALTER POLICY users_can_accept_invite ON public.organization_members USING (false) WITH CHECK (false);\n", "")]),
  # wrong build 2: the view policy left live
  'b_skip_view_policy': ('B', 's01', [("ALTER POLICY users_can_view_own_invite ON public.organization_members USING (false);\n", "")]),
}

def apply(name, src, dst):
    s = open(src).read()
    for a, b in M[name][2]:
        n = s.count(a)
        if n != 1:
            print(f'pattern count {n} != 1 for {name}: {a[:60]!r}', file=sys.stderr); sys.exit(1)
        s = s.replace(a, b)
    open(dst, 'w').write(s)

if __name__ == '__main__':
    if sys.argv[1] == 'list':
        for k, (p, c, _) in M.items(): print(f'{k}|{p}|{c}')
    else:
        apply(sys.argv[2], sys.argv[3], sys.argv[4])
