#!/usr/bin/env python3
"""BACKLOG-4238 PR-1 mutations. For each mode: exact-string replace on the migration (or rollback)
FILE, each fragment required to match exactly the stated number of times (else the mode stops),
print MUTATION APPLIED + the changed lines + `git diff --numstat`, run the controls (one call, one
transaction ending in RAISE), run the migration-text test, print the reds, then restore with
`git checkout --` and assert the file is clean. Commit before running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...] | all
want: 'red'   -> every listed control must turn red
      'green' -> measured equivalent in this venue; kept so the claim stays checked
"""
import json, os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
MIG = 'supabase/migrations/20261112170000_backlog_4238_mcp_oauth_server.sql'
RB = 'supabase/tests/backlog-4238/rollback-4238.sql'
TRIP = 'broker-portal/__tests__/migrations/mcp-oauth-4238.test.ts'

SECRET_BODY = """  SELECT coalesce((
    SELECT p_secret IS NOT NULL
       AND s.portal_secret_sha256 IS NOT NULL
       AND (sha256(convert_to(p_secret, 'UTF8')) = s.portal_secret_sha256
            OR (s.portal_secret_prev_sha256 IS NOT NULL
                AND sha256(convert_to(p_secret, 'UTF8')) = s.portal_secret_prev_sha256))
      FROM public.mcp_settings s
     WHERE s.id), false)
"""
PLAN_SECRET_BODY = """  SELECT p_secret IS NOT NULL AND s.portal_secret_sha256 IS NOT NULL
     AND (sha256(convert_to(p_secret, 'UTF8')) = s.portal_secret_sha256
          OR sha256(convert_to(p_secret, 'UTF8')) = s.portal_secret_prev_sha256)
    FROM public.mcp_settings s
"""
NOCOALESCE_BODY = """  SELECT p_secret IS NOT NULL AND s.portal_secret_sha256 IS NOT NULL
     AND (sha256(convert_to(p_secret, 'UTF8')) = s.portal_secret_sha256
          OR sha256(convert_to(p_secret, 'UTF8')) = s.portal_secret_prev_sha256)
    FROM public.mcp_settings s WHERE s.id
"""
NULL_OK_BODY = """  SELECT coalesce((
    SELECT s.portal_secret_sha256 IS NOT NULL
       AND (sha256(convert_to(p_secret, 'UTF8')) = s.portal_secret_sha256
            OR sha256(convert_to(p_secret, 'UTF8')) IS NOT DISTINCT FROM s.portal_secret_prev_sha256)
      FROM public.mcp_settings s
     WHERE s.id), false)
"""
GATE_SECRET = 'IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN'
EXCH_SECRET = ("  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN\n    RETURN public._mcp_refuse('invalid_grant');\n  END IF;\n"
               "  IF (octet_length(p_code_digest)")
EXCH_SECRET_NEW = "  IF (octet_length(p_code_digest)"
REFR_TOP = ("    RETURN public._mcp_refuse('invalid_grant');\n  END IF;\n  IF (octet_length(p_rt_digest)")
REFR_TOP_OLD_LOCKOUT = ("    RETURN public._mcp_refuse('invalid_grant');\n  END IF;\n"
                        "  IF coalesce((SELECT rc.count FROM public.mcp_rate_counters rc WHERE rc.bucket = 'tok_fail:' || coalesce(p_client_id, '')\n"
                        "                AND rc.window_start = public._mcp_window(interval '1 minute')), 0) >= 20 THEN\n"
                        "    RETURN public._mcp_refuse('rate_limited');\n  END IF;\n  IF (octet_length(p_rt_digest)")
TOKEN_FAIL = ("  IF public._mcp_bump('tok_fail:' || coalesce(p_client_id, ''), interval '1 minute', 20) IS NOT DISTINCT FROM 'ok' THEN\n"
              "    RETURN public._mcp_refuse(p_code);\n  END IF;\n  RETURN public._mcp_refuse('rate_limited');")
REJECT = ("    DELETE FROM public.mcp_connections c\n     WHERE c.id = v_code.connection_id AND c.status = 'pending'\n    RETURNING c.user_id INTO v_user;\n"
          "    INSERT INTO public.mcp_call_log (user_id, connection_id, event, outcome, ended_at)\n    VALUES (v_user, v_code.connection_id, 'code_rejected', 'ok', now());\n")
PRUNE_ALL = ("    DELETE FROM public.mcp_rate_counters o\n     WHERE (o.bucket, o.window_start) IN (\n"
             "       SELECT x.bucket, x.window_start FROM public.mcp_rate_counters x\n"
             "        WHERE x.window_start < now() - interval '1 day'\n        ORDER BY x.bucket, x.window_start\n"
             "        LIMIT 200\n        FOR UPDATE SKIP LOCKED);\n")
EXCH_INS_FAIL = ("      (sha256(p_rt_digest), v_code.connection_id, 'refresh', v_pepper, now() + interval '30 days');\n"
                 "  EXCEPTION WHEN unique_violation OR not_null_violation THEN\n"
                 "    RAISE EXCEPTION USING ERRCODE = 'MC001', MESSAGE = 'mcp token insert failed';")
REFR_INS_FAIL = ("      (sha256(p_new_rt_digest), v_conn, 'refresh', v_pepper, now() + interval '30 days');\n"
                 "  EXCEPTION WHEN unique_violation OR not_null_violation THEN\n"
                 "    RAISE EXCEPTION USING ERRCODE = 'MC001', MESSAGE = 'mcp token insert failed';")
REPLAY_CHECK = ("      IF (v_used.client_id = p_client_id\n          AND (p_redirect_uri IS NULL OR v_used.redirect_uri = p_redirect_uri)\n"
                "          AND p_code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'\n"
                "          AND public._mcp_b64url(sha256(convert_to(p_code_verifier, 'UTF8'))) = v_used.code_challenge) IS TRUE THEN")
UNKNOWN_CLIENT = ("  IF NOT EXISTS (SELECT 1 FROM public.mcp_oauth_clients c WHERE c.client_id = p_client_id) THEN\n"
                  "    RETURN public._mcp_refuse(p_code);\n  END IF;\n")
TOKEN_PRUNE = "  DELETE FROM public.mcp_tokens o\n   WHERE o.connection_id = v_conn AND o.expires_at < now() - interval '1 day';\n"
RO_LINE = "      PERFORM set_config('transaction_read_only', 'on', true);\n      PERFORM set_config('request.jwt.claims'"
RO_LINE_NEW = "      PERFORM set_config('request.jwt.claims'"
MC_EXIT = ("      RAISE EXCEPTION USING ERRCODE = 'MC000', MESSAGE = 'mcp read block done';\n    EXCEPTION\n"
           "      WHEN SQLSTATE 'MC000' THEN NULL;\n      WHEN query_canceled")
MC_EXIT_NEW = "    EXCEPTION\n      WHEN query_canceled"
ENTER_TAIL = "     AND t.kind = 'access'\n     AND t.expires_at > now()\n     AND t.pepper_version = s.pepper_version\n     AND c.status = 'active'\n     AND c.resource = p_resource;\n  IF g.connection_id IS NULL"
APPROVE_NONCE = ("     AND r.claimed_by = v_uid\n     AND r.consent_nonce_sha256 = sha256(convert_to(p_nonce, 'UTF8'))\n  RETURNING r.* INTO v_req;\n"
                 "  IF v_req.id IS NULL THEN\n    RETURN public._mcp_refuse('request_invalid');\n  END IF;\n\n  DELETE")

# mode -> (controls file, [(file, old, new, expected count)], targets, want, description)
MUT = {
  'MW_plan_secret_shape': ('controls.sql', [(MIG, SECRET_BODY, PLAN_SECRET_BODY, 1), (MIG, GATE_SECRET, 'IF NOT public._mcp_secret_ok(p_secret) THEN', 6)],
      'D1_wrong_secret_prev_null D1_settings_row_missing', 'red', "the plan's original secret check: no coalesce, IF NOT at call sites"),
  'M01_call_sites_if_not_only': ('controls.sql', [(MIG, GATE_SECRET, 'IF NOT public._mcp_secret_ok(p_secret) THEN', 6)],
      '', 'green', 'IF NOT at call sites, coalesce kept: the predicate never returns NULL'),
  'M02_no_coalesce_only': ('controls.sql', [(MIG, SECRET_BODY, NOCOALESCE_BODY, 1)],
      '', 'green', 'no coalesce, IS NOT TRUE kept at call sites'),
  'M03_null_secret_matches_null_prev': ('controls.sql', [(MIG, SECRET_BODY, NULL_OK_BODY, 1)],
      'D1_null_secret', 'red', 'no p_secret IS NOT NULL term, previous hash compared with IS NOT DISTINCT FROM'),
  'M04_exchange_without_secret': ('controls.sql', [(MIG, EXCH_SECRET, EXCH_SECRET_NEW, 1)],
      'D1_wrong_secret_prev_null', 'red', 'mcp_exchange_code with the secret check line removed'),
  'M05_status_revoke_keeps_authenticated': ('controls.sql', [(MIG, 'REVOKE ALL ON FUNCTION public.mcp_get_status(text, bytea, text) FROM PUBLIC, anon, authenticated, service_role;',
      'REVOKE ALL ON FUNCTION public.mcp_get_status(text, bytea, text) FROM PUBLIC, anon;', 1)],
      'D2_function_grants', 'red', 'REVOKE FROM PUBLIC, anon only (authenticated and service_role keep EXECUTE)'),
  'M06_create_on_public_kept': ('controls.sql', [(MIG, 'REVOKE CREATE ON SCHEMA public FROM mcp_reader;\n', '', 1)],
      'D2_reader_role', 'red', 'temporary CREATE on schema public not revoked'),
  'M07_reader_bypassrls': ('controls.sql', [(MIG, 'ALTER ROLE mcp_reader NOLOGIN NOBYPASSRLS', 'ALTER ROLE mcp_reader NOLOGIN BYPASSRLS', 1)],
      'D2_reader_role D5_owner_only', 'red', 'reader role with BYPASSRLS'),
  'M08_postgres_inherits_reader': ('controls.sql', [(MIG, 'GRANT mcp_reader TO postgres WITH INHERIT FALSE, SET TRUE;', 'GRANT mcp_reader TO postgres WITH SET TRUE;', 1)],
      'D2_reader_role', 'red', 'postgres membership in mcp_reader with INHERIT (default)'),
  'M09_no_read_only': ('controls.sql', [(MIG, RO_LINE, RO_LINE_NEW, 1)],
      'D3_writes_refused', 'red', 'read block without transaction_read_only (still rolled back)'),
  'M10_block_exits_normally': ('controls.sql', [(MIG, MC_EXIT, MC_EXIT_NEW, 1)],
      'CL_claims_and_read_only_restored', 'red', 'read block exits normally (claims stay set; read-only is restored by the subtransaction end)'),
  'MW_plain_call': ('controls.sql', [(MIG, RO_LINE, RO_LINE_NEW, 1), (MIG, MC_EXIT, MC_EXIT_NEW, 1)],
      'D3_writes_refused CL_claims_and_read_only_restored', 'red', 'MOST LIKELY WRONG: reader called directly, no read-only, no rollback'),
  'M11_no_dispatch_check': ('controls.sql', [(MIG, "  IF public._mcp_reader_ok('public._mcp_r_entitlement()'::regprocedure) IS NOT TRUE THEN\n    v_out := 'error';",
      "  IF false THEN\n    v_out := 'error';", 1)],
      'D4_dispatch_check', 'red', 'get_status without the owner/volatility check'),
  'M12_claims_sub_other_id': ('controls.sql', [(MIG, "jsonb_build_object('sub', g.user_id, 'role', 'authenticated')", "jsonb_build_object('sub', g.connection_id, 'role', 'authenticated')", 1),
      (MIG, "PERFORM set_config('request.jwt.claim.sub', g.user_id::text, true);", "PERFORM set_config('request.jwt.claim.sub', g.connection_id::text, true);", 1)],
      'D5_owner_only', 'red', 'claims sub set to another id'),
  'M13_no_legacy_claim_sub': ('controls.sql', [(MIG, "      PERFORM set_config('request.jwt.claim.sub', g.user_id::text, true);\n", '', 1)],
      '', 'green', 'legacy request.jwt.claim.sub not set (the harness clears it, so auth.uid() falls back to the claims)'),
  'M14_reader_owned_by_postgres': ('controls.sql', [(MIG, 'SET ROLE mcp_reader;\n', '', 1), (MIG, '\nRESET ROLE;\nREVOKE CREATE ON SCHEMA public FROM mcp_reader;', '\nREVOKE CREATE ON SCHEMA public FROM mcp_reader;', 1)],
      'D2_reader_role D3_positive_clean_reader D5_owner_only', 'red', 'reader created as postgres instead of mcp_reader'),
  'M15_enter_ignores_expiry': ('controls.sql', [(MIG, ENTER_TAIL, ENTER_TAIL.replace("     AND t.expires_at > now()\n", ''), 1)],
      'D6_token_resolution', 'red', 'gate without the access-token expiry'),
  'M16_enter_ignores_pepper': ('controls.sql', [(MIG, ENTER_TAIL, ENTER_TAIL.replace("     AND t.pepper_version = s.pepper_version\n", ''), 1)],
      'D6_token_resolution', 'red', 'gate without the pepper version'),
  'M17_enter_ignores_kind': ('controls.sql', [(MIG, ENTER_TAIL, ENTER_TAIL.replace("     AND t.kind = 'access'\n", ''), 1)],
      'D6_token_resolution', 'red', 'gate accepts a refresh token as access'),
  'M18_code_reusable': ('controls.sql', [(MIG, "     AND k.used_at IS NULL\n     AND k.expires_at > now()\n  RETURNING k.* INTO v_code;", "     AND k.expires_at > now()\n  RETURNING k.* INTO v_code;", 1)],
      'D7_code_single_use', 'red', 'code redemption without used_at IS NULL'),
  'M19_replay_keeps_connection': ('controls.sql', [(MIG, "        DELETE FROM public.mcp_connections c WHERE c.id = v_used.connection_id;\n", '', 1)],
      'D7_code_single_use R2_replay_valid_removes_connection', 'red', 'code replay does not disconnect'),
  'M20_pkce_unhashed': ('controls.sql', [(MIG, "public._mcp_b64url(sha256(convert_to(p_code_verifier, 'UTF8'))) = v_code.code_challenge", 'p_code_verifier = v_code.code_challenge', 1)],
      'D8_pkce_and_bindings', 'red', 'verifier compared to the challenge without hashing (plain method)'),
  'M21_exchange_ignores_redirect': ('controls.sql', [(MIG, '      AND (p_redirect_uri IS NULL OR v_code.redirect_uri = p_redirect_uri)\n      AND v_code.resource', '      AND v_code.resource', 1)],
      'D8_pkce_and_bindings', 'red', 'exchange without the redirect comparison'),
  'M22_exchange_ignores_client': ('controls.sql', [(MIG, '  IF (v_code.client_id = p_client_id\n      AND (p_redirect_uri IS NULL', '  IF (true\n      AND (p_redirect_uri IS NULL', 1)],
      'D8_pkce_and_bindings', 'red', 'exchange without the client comparison'),
  'M23_exchange_ignores_resource': ('controls.sql', [(MIG, '      AND v_code.resource = p_resource\n', '', 1)],
      'D8_pkce_and_bindings', 'red', 'exchange without the resource comparison'),
  'M24_allowlist_prefix': ('controls.sql', [(MIG, 'WHERE a.redirect_uri = u.uri', "WHERE u.uri LIKE a.redirect_uri || '%'", 1)],
      'D9_allowlist_exact', 'red', 'registration matches an allowlist prefix'),
  'M25_refresh_reusable': ('controls.sql', [(MIG, "     AND t.kind = 'refresh'\n     AND t.used_at IS NULL\n     AND t.expires_at > now()\n     AND s.id", "     AND t.kind = 'refresh'\n     AND t.expires_at > now()\n     AND s.id", 1)],
      'D10_refresh_reuse_revokes', 'red', 'refresh without used_at IS NULL'),
  'M26_reuse_keeps_connection': ('controls.sql', [(MIG, '      DELETE FROM public.mcp_connections c WHERE c.id = v_conn;\n', '', 1)],
      'D10_refresh_reuse_revokes', 'red', 'refresh reuse does not disconnect'),
  'M27_disconnect_any_owner': ('controls.sql', [(MIG, '   WHERE c.id = p_connection_id AND c.user_id = v_uid', '   WHERE c.id = p_connection_id', 1)],
      'D11_cross_user_and_impersonation', 'red', 'disconnect without the owner filter'),
  'M28_impersonation_active_only': ('controls.sql', [(MIG, "i.status IN ('active', 'validated')", "i.status = 'active'", 1)],
      'D11_cross_user_and_impersonation', 'red', "impersonation check ignores the 'validated' status"),
  'M29_impersonation_not_checked': ('controls.sql', [(MIG, "  IF public._mcp_impersonating(v_uid) IS NOT FALSE THEN\n    RETURN public._mcp_refuse('impersonating');", "  IF false THEN\n    RETURN public._mcp_refuse('impersonating');", 5)],
      'D11_cross_user_and_impersonation', 'red', 'consent functions without the impersonation check'),
  'M30_view_ignores_claim': ('controls.sql', [(MIG, '     AND (r.claimed_by IS NULL OR r.claimed_by = v_uid)\n', '', 1)],
      'D11_cross_user_and_impersonation', 'red', 'view without the claimed_by term'),
  'M31_enabled_by_default': ('controls.sql', [(MIG, 'enabled                   boolean NOT NULL DEFAULT false,', 'enabled                   boolean NOT NULL DEFAULT true,', 1)],
      'D12_fresh_apply_disabled_no_secret', 'red', 'kill switch on by default'),
  'M32_gate_ignores_kill_switch': ('controls.sql', [(MIG, "  IF (SELECT s.enabled FROM public.mcp_settings s WHERE s.id) IS NOT TRUE THEN\n    g.outcome := 'disabled';", "  IF false THEN\n    g.outcome := 'disabled';", 1)],
      'D12_kill_switch', 'red', 'gate without the kill switch'),
  'M33_refusal_raises': ('controls.sql', [(MIG, "  IF g.outcome IS DISTINCT FROM 'ok' THEN\n    RETURN public._mcp_refuse(g.outcome);", "  IF g.outcome IS DISTINCT FROM 'ok' THEN\n    RAISE EXCEPTION 'refused %', g.outcome;", 1)],
      'D12_kill_switch D13_rate_limited_logged', 'red', 'a refusal raises instead of returning (log row lost)'),
  'M34_outcome_ne': ('controls.sql', [(MIG, "  IF g.outcome IS DISTINCT FROM 'ok' THEN", "  IF g.outcome <> 'ok' THEN", 1)],
      '', 'green', "outcome compared with <> (the gate never returns a NULL outcome); the migration-text test catches it"),
  'M35_missing_state_fn_entitled': ('controls.sql', [(MIG, "    RETURN jsonb_build_object('entitled', false, 'reason', 'cloud_not_built');", "    RETURN jsonb_build_object('entitled', true, 'reason', 'cloud_not_built');", 1)],
      'D15a_cloud_not_built', 'red', 'missing state function treated as entitled'),
  'M36_no_schema_version_check': ('controls.sql', [(MIG, "  IF (v_state -> 'schema_version') IS DISTINCT FROM to_jsonb(1) THEN\n    RETURN jsonb_build_object('entitled', false, 'reason', 'state_unavailable');\n  END IF;\n", '', 1)],
      'D15_entitlement', 'red', 'state schema_version not checked'),
  'M37_approve_ignores_cloud': ('controls.sql', [(MIG, '  IF (SELECT s.connect_requires_cloud FROM public.mcp_settings s WHERE s.id) IS NOT FALSE\n     AND', '  IF false\n     AND', 1)],
      'D15_entitlement', 'red', 'approve without the entitlement check'),
  'M38_view_ignores_binding': ('controls.sql', [(MIG, '     AND r.browser_binding_sha256 = p_browser_binding_sha256\n     AND (r.claimed_by IS NULL', '     AND (r.claimed_by IS NULL', 1)],
      'D16_consent_binding', 'red', 'view without the browser binding'),
  'M39_approve_ignores_nonce': ('controls.sql', [(MIG, APPROVE_NONCE, APPROVE_NONCE.replace("     AND r.consent_nonce_sha256 = sha256(convert_to(p_nonce, 'UTF8'))\n", ''), 1)],
      'D16_consent_binding', 'red', 'approve without the nonce'),
  'M40_disconnect_all_everyone': ('controls.sql', [(MIG, '  DELETE FROM public.mcp_connections c WHERE c.user_id = p_user_id;', '  DELETE FROM public.mcp_connections c WHERE c.user_id IS NOT NULL;', 1)],
      'D17_disconnect_all', 'red', 'disconnect-all without the user filter'),
  'M41_reconnect_replaces_all_apps': ('controls.sql', [(MIG, '   WHERE c.user_id = v_user AND c.redirect_uri = v_redir AND c.id <> v_code.connection_id', '   WHERE c.user_id = v_user AND c.id <> v_code.connection_id', 1)],
      'D18_reconnect_replaces', 'red', 'reconnect replaces every app of the user'),
  'M42_claims_outside_block': ('controls.sql', [(MIG, "  ELSE\n    BEGIN\n      PERFORM set_config('transaction_read_only', 'on', true);\n      PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', g.user_id, 'role', 'authenticated')::text, true);",
      "  ELSE\n    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', g.user_id, 'role', 'authenticated')::text, true);\n    BEGIN\n      PERFORM set_config('transaction_read_only', 'on', true);", 1)],
      'CL_claims_and_read_only_restored', 'red', 'claims set outside the rolled-back block'),
  'M43_no_timeout_handler': ('controls-timeout.sql', [(MIG, "      WHEN query_canceled THEN v_out := 'timeout'; v_ent := NULL;\n", '', 1)],
      'C8_timeout_in_read_block', 'red', 'a timeout inside the read block is not caught (the call and its log row are lost)'),
  'M44_rollback_leaves_log': ('controls.sql', [(RB, 'DROP TABLE IF EXISTS public.mcp_call_log;\n', '', 1)],
      'G1_rollback_then_apply', 'red', 'rollback leaves mcp_call_log'),
  'M45_register_ignores_null_element': ('controls.sql', [(MIG, '      AND array_position(p_redirect_uris, NULL) IS NULL\n', '', 1)],
      '', 'green', 'no array_position NULL term: a NULL element already fails the allowlist subquery'),
  'B1_sequence_revoke_removed': ('controls.sql', [(MIG, 'REVOKE ALL ON SEQUENCE public.mcp_call_log_id_seq FROM PUBLIC, anon, authenticated;\n', '', 1)],
      'D2_sequences_and_type_closed', 'red', 'call-log sequence REVOKE line removed'),
  'B1_type_revoke_removed': ('controls.sql', [(MIG, 'REVOKE ALL ON TYPE public.mcp_gate FROM PUBLIC, anon, authenticated;\n', '', 1)],
      'D2_sequences_and_type_closed', 'red', 'mcp_gate type REVOKE line removed'),
  'X1_refresh_ignores_client': ('controls.sql', [(MIG, "     AND c.client_id = p_client_id\n", '', 1)],
      'B2_refresh_client_resource_bound', 'red', 'refresh UPDATE without the client term'),
  'X2_refresh_ignores_resource': ('controls.sql', [(MIG, "     AND c.resource = p_resource\n  RETURNING t.connection_id", "  RETURNING t.connection_id", 1)],
      'B2_refresh_client_resource_bound', 'red', 'refresh UPDATE without the resource term'),
  'X3_code_never_expires': ('controls.sql', [(MIG, "     AND k.used_at IS NULL\n     AND k.expires_at > now()\n", "     AND k.used_at IS NULL\n", 1)],
      'B2_code_expiry', 'red', 'code redemption without the expiry term'),
  'X4_refresh_never_expires': ('controls.sql', [(MIG, "     AND t.used_at IS NULL\n     AND t.expires_at > now()\n     AND s.id", "     AND t.used_at IS NULL\n     AND s.id", 1)],
      'B2_refresh_expiry_pepper_kind', 'red', 'refresh UPDATE without the expiry term'),
  'X5_refresh_ignores_pepper': ('controls.sql', [(MIG, "     AND s.id\n     AND t.pepper_version = s.pepper_version\n     AND c.id = t.connection_id", "     AND s.id\n     AND c.id = t.connection_id", 1)],
      'B2_refresh_expiry_pepper_kind', 'red', 'refresh UPDATE without the pepper term'),
  'X6_refresh_accepts_access_kind': ('controls.sql', [(MIG, "     AND t.kind = 'refresh'\n     AND t.used_at IS NULL\n     AND t.expires_at", "     AND t.used_at IS NULL\n     AND t.expires_at", 1)],
      'B2_refresh_expiry_pepper_kind', 'red', 'refresh UPDATE without the kind term (the table CHECK then raises)'),
  'X7_no_token_failure_lockout': ('controls.sql', [(MIG, TOKEN_FAIL, "  RETURN public._mcp_refuse(p_code);", 1)],
      'B3_lockout_failures_only', 'red', 'failure counter not consulted'),
  'B3_lockout_checked_before_token': ('controls.sql', [(MIG, REFR_TOP, REFR_TOP_OLD_LOCKOUT, 1)],
      'B3_lockout_failures_only', 'red', 'refresh checks the failure count before the token (previous ordering)'),
  'X8_view_ignores_kill_switch': ('controls.sql', [(MIG, "  IF (SELECT s.enabled FROM public.mcp_settings s WHERE s.id) IS NOT TRUE THEN\n    RETURN public._mcp_refuse('disabled');\n  END IF;\n  v_nonce", "  v_nonce", 1)],
      'B2_view_kill_switch', 'red', 'view without the kill switch term'),
  'X9_approve_skips_client_redirect': ('controls.sql', [(MIG, "     AND v_req.redirect_uri = ANY (c.redirect_uris)\n  RETURNING id INTO v_conn;", "  RETURNING id INTO v_conn;", 1)],
      'B2_approve_client_redirects', 'red', 'approve INSERT without the client redirect-list term'),
  'X10_no_user_cap': ('controls.sql', [(MIG, "interval '1 minute', 60);", "interval '1 minute', 100000);", 1)],
      'B2_per_user_cap', 'red', 'per-user limit raised to 100000'),
  'X11_no_registration_limit': ('controls.sql', [(MIG, "interval '1 hour', 60);", "interval '1 hour', 100000);", 1)],
      'B2_registration_ip_limit', 'red', 'per-IP registration limit raised to 100000'),
  'N1_rejection_keeps_connection': ('controls.sql', [(MIG, REJECT, '', 1)],
      'N1_wrong_verifier_uses_up_code', 'red', 'rejected redemption leaves the pending connection and writes no event'),
  'N2_exchange_skips_allowlist': ('controls.sql', [(MIG, "      AND EXISTS (SELECT 1 FROM public.mcp_redirect_allowlist a WHERE a.redirect_uri = v_code.redirect_uri)\n", '', 1)],
      'N2_exchange_rechecks_allowlist R1_exchange_null_redirect', 'red', 'exchange without the allowlist term'),
  'N3_no_counter_prune': ('controls.sql', [(MIG, PRUNE_ALL, '', 1)],
      'N3_inline_pruning', 'red', 'counter prune removed'),
  'R3_prune_own_bucket_only': ('controls.sql', [(MIG, "        WHERE x.window_start < now() - interval '1 day'\n", "        WHERE x.bucket = p_bucket AND x.window_start < now() - interval '1 day'\n", 1)],
      'N3_inline_pruning', 'red', 'counter prune limited to the bumped bucket (previous shape)'),
  'R3_prune_live_windows': ('controls.sql', [(MIG, "        WHERE x.window_start < now() - interval '1 day'\n", "        WHERE x.window_start < now()\n", 1)],
      'N3_inline_pruning', 'red', 'counter prune without the one-day age term'),
  'N3_no_token_prune': ('controls.sql', [(MIG, TOKEN_PRUNE, '', 1)],
      'N3_inline_pruning', 'red', 'token prune removed'),
  'N3_prune_used_refresh': ('controls.sql', [(MIG, "   WHERE o.connection_id = v_conn AND o.expires_at < now() - interval '1 day';", "   WHERE o.connection_id = v_conn AND (o.expires_at < now() - interval '1 day' OR o.used_at IS NOT NULL);", 1)],
      'N3_inline_pruning', 'red', 'token prune also removes used refresh tokens'),
  'N5_check_access_ignores_kill_switch': ('controls.sql', [(MIG, "                AND s.enabled\n", '', 1)],
      'N5_check_access_kill_switch', 'red', 'check_access without the enabled term'),
  'W4_rejection_deletes_all_user_connections': ('controls.sql', [(MIG, "    DELETE FROM public.mcp_connections c\n     WHERE c.id = v_code.connection_id AND c.status = 'pending'\n    RETURNING c.user_id INTO v_user;",
      "    DELETE FROM public.mcp_connections c\n     WHERE c.user_id = (SELECT x.user_id FROM public.mcp_connections x WHERE x.id = v_code.connection_id)\n    RETURNING c.user_id INTO v_user;", 1)],
      'N1_wrong_verifier_uses_up_code', 'red', 'rejected-redemption DELETE keyed on the user instead of the connection'),
  'W2_token_prune_all_connections': ('controls.sql', [(MIG, "   WHERE o.connection_id = v_conn AND o.expires_at < now() - interval '1 day';", "   WHERE o.expires_at < now() - interval '1 day';", 1)],
      'N3b_token_prune_scope', 'red', 'token prune without the connection term'),
  'W3_insert_failure_returns_in_handler': ('controls.sql', [(MIG, EXCH_INS_FAIL, EXCH_INS_FAIL.replace("    RAISE EXCEPTION USING ERRCODE = 'MC001', MESSAGE = 'mcp token insert failed';", "    RETURN public._mcp_refuse('invalid_request');"), 1)],
      'W3_exchange_insert_failure_rolls_back', 'red', 'token insert failure returns from the inner handler (previous shape)'),
  'R1_null_redirect_refused': ('controls.sql', [(MIG, '      AND (p_redirect_uri IS NULL OR v_code.redirect_uri = p_redirect_uri)\n      AND v_code.resource', '      AND v_code.redirect_uri = p_redirect_uri\n      AND v_code.resource', 1)],
      'R1_exchange_null_redirect', 'red', 'exchange redirect term without the IS NULL arm'),
  'R1_any_redirect_accepted': ('controls.sql', [(MIG, '      AND (p_redirect_uri IS NULL OR v_code.redirect_uri = p_redirect_uri)\n      AND v_code.resource', '      AND (p_redirect_uri IS NULL OR true)\n      AND v_code.resource', 1)],
      'D8_pkce_and_bindings', 'red', 'exchange accepts NULL and also any other redirect address'),
  'R1_allowlist_on_parameter': ('controls.sql', [(MIG, "      AND EXISTS (SELECT 1 FROM public.mcp_redirect_allowlist a WHERE a.redirect_uri = v_code.redirect_uri)\n",
      "      AND (p_redirect_uri IS NULL OR EXISTS (SELECT 1 FROM public.mcp_redirect_allowlist a WHERE a.redirect_uri = p_redirect_uri))\n", 1)],
      'R1_exchange_null_redirect', 'red', 'allowlist checked on the parameter, skipped when it is NULL'),
  'R2_replay_ignores_verifier': ('controls.sql', [(MIG, REPLAY_CHECK, REPLAY_CHECK.replace("\n          AND p_code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'\n          AND public._mcp_b64url(sha256(convert_to(p_code_verifier, 'UTF8'))) = v_used.code_challenge) IS TRUE THEN", ") IS TRUE THEN"), 1)],
      'R2_replay_invalid_keeps_connection', 'red', 'replay check without the verifier terms'),
  'R2_replay_ignores_client': ('controls.sql', [(MIG, REPLAY_CHECK, REPLAY_CHECK.replace("      IF (v_used.client_id = p_client_id\n", "      IF (true\n"), 1)],
      'R2_replay_invalid_keeps_connection', 'red', 'replay check without the client term'),
  'R2_replay_ignores_redirect': ('controls.sql', [(MIG, REPLAY_CHECK, REPLAY_CHECK.replace("          AND (p_redirect_uri IS NULL OR v_used.redirect_uri = p_redirect_uri)\n", ""), 1)],
      'R2_replay_invalid_keeps_connection', 'red', 'replay check without the redirect term'),
  'R2_replay_always_removes': ('controls.sql', [(MIG, REPLAY_CHECK, "      IF true THEN", 1)],
      'R2_replay_invalid_keeps_connection', 'red', 'replay removes the connection for any presenter (previous behaviour)'),
  'R3_unknown_client_counted': ('controls.sql', [(MIG, UNKNOWN_CLIENT, '', 1)],
      'R3_unknown_client_no_counter_rows', 'red', 'failure counter created for any client id (previous shape)'),
  'R3_known_client_not_counted': ('controls.sql', [(MIG, "WHERE c.client_id = p_client_id) THEN\n    RETURN public._mcp_refuse(p_code);", "WHERE c.client_id = p_client_id AND false) THEN\n    RETURN public._mcp_refuse(p_code);", 1)],
      'B3_lockout_failures_only', 'red', 'existence check never true: registered clients not counted'),
  'R4_refresh_insert_failure_returns_in_handler': ('controls.sql', [(MIG, REFR_INS_FAIL, REFR_INS_FAIL.replace("    RAISE EXCEPTION USING ERRCODE = 'MC001', MESSAGE = 'mcp token insert failed';", "    RETURN public._mcp_refuse('invalid_request');"), 1)],
      'R4_refresh_insert_failure_rolls_back', 'red', 'refresh token insert failure returns from the inner handler (previous shape)'),
  'R5_registration_limit_59': ('controls.sql', [(MIG, "interval '1 hour', 60);", "interval '1 hour', 59);", 1)],
      'B2_registration_ip_limit', 'red', 'registration limit 59 (the 60th refused)'),
  'R5_registration_limit_61': ('controls.sql', [(MIG, "interval '1 hour', 60);", "interval '1 hour', 61);", 1)],
      'B2_registration_ip_limit', 'red', 'registration limit 61 (the 61st allowed)'),
}


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)


def run_controls(ctl):
    out = subprocess.run([os.path.join(here, 'run.sh'), ctl], capture_output=True, text=True)
    o = out.stdout
    try:
        return json.loads(o[o.index('{'):o.rindex('}') + 1]), o
    except Exception:
        return None, o + out.stderr


def run_trip():
    out = subprocess.run(['npx', 'jest', '--config', 'broker-portal/jest.config.js', TRIP], capture_output=True, text=True, cwd=root)
    tail = [l for l in (out.stdout + out.stderr).splitlines() if l.startswith('Tests:')]
    return out.returncode, (tail[-1] if tail else 'Tests: ?')


if sh('git', 'status', '--porcelain', '--', MIG, RB).stdout.strip():
    sys.exit('migration/rollback have uncommitted changes; commit before mutating')

modes = list(MUT) if sys.argv[1] == 'all' else sys.argv[1].split(',')
missed = 0
for mode in modes:
    ctl, edits, targets, want, desc = MUT[mode]
    files = sorted({f for f, *_ in edits})
    try:
        applied = True
        for fn, old, new, cnt in edits:
            path = os.path.join(root, fn)
            body = open(path).read()
            n = body.count(old)
            if n != cnt:
                print('== %s\nMUTATION NOT APPLIED: fragment matched %d times (expected %d)' % (mode, n, cnt))
                applied = False
                break
            open(path, 'w').write(body.replace(old, new))
        if not applied:
            missed += 1
            continue
        ns = sh('git', 'diff', '--numstat', '--', *files).stdout.strip()
        if not ns:
            print('== %s\nMUTATION NOT APPLIED: git diff empty' % mode)
            missed += 1
            continue
        changed = [l for l in sh('git', 'diff', '-U0', '--', *files).stdout.splitlines()
                   if l[:1] in '+-' and not l.startswith(('+++', '---'))]
        print('== %s (want %s) %s' % (mode, want, desc))
        print('MUTATION APPLIED numstat=%s' % ' '.join(x.split('\t')[0] + '/' + x.split('\t')[1] for x in ns.splitlines()))
        for l in changed[:8]:
            print('  %s %s' % (l[0], l[1:].strip()[:150]))
        d, raw = run_controls(ctl)
        if d is None:
            reds = {'NO_RESULT': raw.replace('\n', ' ')[:300]}
            print('RESULT none: %s' % reds['NO_RESULT'])
        else:
            reds = d['reds']
            print('RESULT total=%s pass=%s fail=%s reds=%s' % (d['total'], d['pass'], d['fail'], ','.join(sorted(reds)) or 'none'))
            if not d['total']:
                print('ZERO CONTROLS RAN')
        trc, trs = run_trip()
        print('TRIPWIRE %s (%s)' % ('RED' if trc else 'green', trs))
        tl = targets.split()
        if want == 'red':
            if d is None and ctl == 'controls-timeout.sql':
                verdict = 'as expected (call aborted, no result)'
            else:
                miss = [t for t in tl if t not in reds and not any(k.startswith(t.split('_')[0] + '_crash') for k in reds)]
                verdict = 'as expected' if not miss else 'MISSED: %s stayed green' % ','.join(miss)
        else:
            verdict = 'as expected (equivalent)' if not reds else 'NOT EQUIVALENT: %s red' % ','.join(sorted(reds))
        if not verdict.startswith('as expected'):
            missed += 1
        print('VERDICT %s' % verdict)
    finally:
        sh('git', 'checkout', '--', *files)
        st = sh('git', 'status', '--porcelain', '--', *files).stdout.strip()
        print('RESTORED clean=%s' % (st == ''))
        if st:
            sys.exit('restore failed')
print('mutants: %d run, %d not as expected' % (len(modes), missed))
