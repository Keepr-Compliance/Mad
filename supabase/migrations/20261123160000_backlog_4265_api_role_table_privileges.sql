-- ============================================================================
-- Migration: revokes all privileges of role service_role on 18 tables and 1 sequence (BACKLOG-4265)
--
-- Tables:
--   cloud_deal_messages, cloud_deal_files, cloud_blobs
--   mcp_settings, mcp_redirect_allowlist, mcp_oauth_clients, mcp_authorization_requests, mcp_connections,
--   mcp_authorization_codes, mcp_tokens, mcp_rate_counters, mcp_call_log
--   cloud_deals, cloud_deal_parties, cloud_deal_checklists, cloud_deal_checklist_items, cloud_autosave_settings,
--   member_addons
-- Sequence: public.mcp_call_log_id_seq (the identity sequence of public.mcp_call_log.id).
-- Privileges of every other role (anon, authenticated, PUBLIC, mcp_reader, the owner) are unchanged; the post-check
--   compares them with a fingerprint the pre-check takes in this transaction.
-- No function, policy, default privilege, storage object or row is changed.
-- Pre-check (refuses, nothing applied): current_user is postgres; each relation exists, is owned by postgres and has the
--   expected kind; mcp_call_log_id_seq is the identity sequence of mcp_call_log.id; every ACL entry for service_role on
--   these relations has grantor postgres (the owner).
-- Post-check (refuses, nothing applied): on each relation service_role holds no table privilege of any type (MAINTAIN
--   included on PostgreSQL 17 and later), no column privilege and no ACL entry; no sequence privilege on the sequence;
--   the other roles' ACL entries (table and column) equal the pre-check fingerprint.
-- Locks: lock_timeout 3s is the first statement; if a lock is not obtained in 3 seconds nothing is applied. The lock
--   mode of the privilege change is not measured here (supabase/tests/backlog-4265/README.md).
-- Re-runnable: a second run finds no service_role entry, changes nothing and passes both checks.
-- Deploy order: after 20261123130000.
-- Rollback: supabase/tests/backlog-4265/rollback-20261123160000.sql
-- ============================================================================

SET LOCAL lock_timeout = '3s';

DO $pre4265$
DECLARE
  r record;
  v_bad text := '';
  v_fp text;
BEGIN
  IF current_user IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION '4265 pre-check: current_user is %, not postgres', current_user;
  END IF;
  FOR r IN
    SELECT x.name, x.kind, c.oid, c.relkind, pg_catalog.pg_get_userbyid(c.relowner) AS owner
      FROM (VALUES ('cloud_deal_messages', 'r'), ('cloud_deal_files', 'r'), ('cloud_blobs', 'r'),
                   ('mcp_settings', 'r'), ('mcp_redirect_allowlist', 'r'), ('mcp_oauth_clients', 'r'),
                   ('mcp_authorization_requests', 'r'), ('mcp_connections', 'r'), ('mcp_authorization_codes', 'r'),
                   ('mcp_tokens', 'r'), ('mcp_rate_counters', 'r'), ('mcp_call_log', 'r'),
                   ('cloud_deals', 'r'), ('cloud_deal_parties', 'r'), ('cloud_deal_checklists', 'r'),
                   ('cloud_deal_checklist_items', 'r'), ('cloud_autosave_settings', 'r'), ('member_addons', 'r'),
                   ('mcp_call_log_id_seq', 'S')) x(name, kind)
      LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass('public.' || x.name)
  LOOP
    IF r.oid IS NULL THEN
      v_bad := v_bad || r.name || ' missing; ';
    ELSIF r.relkind::text IS DISTINCT FROM r.kind THEN
      v_bad := v_bad || r.name || ' kind ' || r.relkind::text || '; ';
    ELSIF r.owner IS DISTINCT FROM 'postgres' THEN
      v_bad := v_bad || r.name || ' owner ' || r.owner || '; ';
    ELSIF EXISTS (SELECT 1 FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
                   WHERE c.oid = r.oid AND a.grantee = 'service_role'::regrole AND a.grantor IS DISTINCT FROM c.relowner) THEN
      v_bad := v_bad || r.name || ' ACL entry for service_role has grantor '
               || (SELECT string_agg(DISTINCT pg_catalog.pg_get_userbyid(a.grantor), ',') FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
                    WHERE c.oid = r.oid AND a.grantee = 'service_role'::regrole AND a.grantor IS DISTINCT FROM c.relowner) || '; ';
    END IF;
  END LOOP;
  IF pg_catalog.pg_get_serial_sequence('public.mcp_call_log', 'id') IS DISTINCT FROM 'public.mcp_call_log_id_seq' THEN
    v_bad := v_bad || 'identity sequence of mcp_call_log.id is ' || coalesce(pg_catalog.pg_get_serial_sequence('public.mcp_call_log', 'id'), 'none') || '; ';
  END IF;
  IF v_bad <> '' THEN
    RAISE EXCEPTION '4265 pre-check: %', v_bad;
  END IF;
  SELECT md5(coalesce(string_agg(z.s, '|' ORDER BY z.s COLLATE "C"), '')) INTO v_fp
    FROM (SELECT c.relname::text || '::'
                 || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ':'
                 || pg_catalog.pg_get_userbyid(a.grantor)::text || ':' || a.privilege_type || ':' || a.is_grantable::text AS s
            FROM pg_catalog.pg_class c
            CROSS JOIN LATERAL aclexplode(c.relacl) a
           WHERE c.relnamespace = 'public'::regnamespace AND a.grantee IS DISTINCT FROM 'service_role'::regrole
             AND c.relname IN ('cloud_deal_messages', 'cloud_deal_files', 'cloud_blobs', 'mcp_settings', 'mcp_redirect_allowlist',
                               'mcp_oauth_clients', 'mcp_authorization_requests', 'mcp_connections', 'mcp_authorization_codes',
                               'mcp_tokens', 'mcp_rate_counters', 'mcp_call_log', 'cloud_deals', 'cloud_deal_parties',
                               'cloud_deal_checklists', 'cloud_deal_checklist_items', 'cloud_autosave_settings', 'member_addons',
                               'mcp_call_log_id_seq')
          UNION ALL
          SELECT c.relname::text || ':' || t.attname::text || ':'
                 || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ':'
                 || pg_catalog.pg_get_userbyid(a.grantor)::text || ':' || a.privilege_type || ':' || a.is_grantable::text
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_attribute t ON t.attrelid = c.oid AND t.attnum > 0 AND NOT t.attisdropped
            CROSS JOIN LATERAL aclexplode(t.attacl) a
           WHERE c.relnamespace = 'public'::regnamespace AND a.grantee IS DISTINCT FROM 'service_role'::regrole
             AND c.relname IN ('cloud_deal_messages', 'cloud_deal_files', 'cloud_blobs', 'mcp_settings', 'mcp_redirect_allowlist',
                               'mcp_oauth_clients', 'mcp_authorization_requests', 'mcp_connections', 'mcp_authorization_codes',
                               'mcp_tokens', 'mcp_rate_counters', 'mcp_call_log', 'cloud_deals', 'cloud_deal_parties',
                               'cloud_deal_checklists', 'cloud_deal_checklist_items', 'cloud_autosave_settings', 'member_addons')) z;
  PERFORM set_config('keepr.m4265_other_acl', v_fp, true);
END
$pre4265$;

-- tables: cloud_deal_messages, cloud_deal_files, cloud_blobs
REVOKE ALL ON TABLE public.cloud_deal_messages, public.cloud_deal_files, public.cloud_blobs FROM service_role;

-- tables: mcp_settings, mcp_redirect_allowlist, mcp_oauth_clients, mcp_authorization_requests, mcp_connections,
--   mcp_authorization_codes, mcp_tokens, mcp_rate_counters, mcp_call_log
REVOKE ALL ON TABLE public.mcp_settings, public.mcp_redirect_allowlist, public.mcp_oauth_clients, public.mcp_authorization_requests,
  public.mcp_connections, public.mcp_authorization_codes, public.mcp_tokens, public.mcp_rate_counters, public.mcp_call_log FROM service_role;

-- sequence: mcp_call_log_id_seq
REVOKE ALL ON SEQUENCE public.mcp_call_log_id_seq FROM service_role;

-- tables: cloud_deals, cloud_deal_parties, cloud_deal_checklists, cloud_deal_checklist_items, cloud_autosave_settings,
--   member_addons
REVOKE ALL ON TABLE public.cloud_deals, public.cloud_deal_parties, public.cloud_deal_checklists, public.cloud_deal_checklist_items,
  public.cloud_autosave_settings, public.member_addons FROM service_role;

DO $post4265$
DECLARE
  r record;
  p text;
  v_bad text := '';
  v_fp text;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname::text AS name, c.relkind
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname IN ('cloud_deal_messages', 'cloud_deal_files', 'cloud_blobs', 'mcp_settings', 'mcp_redirect_allowlist',
                         'mcp_oauth_clients', 'mcp_authorization_requests', 'mcp_connections', 'mcp_authorization_codes',
                         'mcp_tokens', 'mcp_rate_counters', 'mcp_call_log', 'cloud_deals', 'cloud_deal_parties',
                         'cloud_deal_checklists', 'cloud_deal_checklist_items', 'cloud_autosave_settings', 'member_addons',
                         'mcp_call_log_id_seq')
  LOOP
    IF EXISTS (SELECT 1 FROM aclexplode((SELECT c.relacl FROM pg_catalog.pg_class c WHERE c.oid = r.oid)) a
                WHERE a.grantee = 'service_role'::regrole) THEN
      v_bad := v_bad || r.name || ' ACL entry for service_role; ';
    END IF;
    IF r.relkind = 'S' THEN
      FOREACH p IN ARRAY ARRAY['USAGE', 'SELECT', 'UPDATE'] LOOP
        IF has_sequence_privilege('service_role', r.oid, p) THEN
          v_bad := v_bad || r.name || ' ' || p || '; ';
        END IF;
      END LOOP;
    ELSE
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                         || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END LOOP
        IF has_table_privilege('service_role', r.oid, p) THEN
          v_bad := v_bad || r.name || ' ' || p || '; ';
        END IF;
      END LOOP;
      IF has_any_column_privilege('service_role', r.oid, 'SELECT, INSERT, UPDATE, REFERENCES') THEN
        v_bad := v_bad || r.name || ' column privilege; ';
      END IF;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('cloud_deal_messages', 'cloud_deal_files', 'cloud_blobs', 'mcp_settings', 'mcp_redirect_allowlist',
                           'mcp_oauth_clients', 'mcp_authorization_requests', 'mcp_connections', 'mcp_authorization_codes',
                           'mcp_tokens', 'mcp_rate_counters', 'mcp_call_log', 'cloud_deals', 'cloud_deal_parties',
                           'cloud_deal_checklists', 'cloud_deal_checklist_items', 'cloud_autosave_settings', 'member_addons',
                           'mcp_call_log_id_seq')) <> 19 THEN
    v_bad := v_bad || 'relation count; ';
  END IF;
  SELECT md5(coalesce(string_agg(z.s, '|' ORDER BY z.s COLLATE "C"), '')) INTO v_fp
    FROM (SELECT c.relname::text || '::'
                 || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ':'
                 || pg_catalog.pg_get_userbyid(a.grantor)::text || ':' || a.privilege_type || ':' || a.is_grantable::text AS s
            FROM pg_catalog.pg_class c
            CROSS JOIN LATERAL aclexplode(c.relacl) a
           WHERE c.relnamespace = 'public'::regnamespace AND a.grantee IS DISTINCT FROM 'service_role'::regrole
             AND c.relname IN ('cloud_deal_messages', 'cloud_deal_files', 'cloud_blobs', 'mcp_settings', 'mcp_redirect_allowlist',
                               'mcp_oauth_clients', 'mcp_authorization_requests', 'mcp_connections', 'mcp_authorization_codes',
                               'mcp_tokens', 'mcp_rate_counters', 'mcp_call_log', 'cloud_deals', 'cloud_deal_parties',
                               'cloud_deal_checklists', 'cloud_deal_checklist_items', 'cloud_autosave_settings', 'member_addons',
                               'mcp_call_log_id_seq')
          UNION ALL
          SELECT c.relname::text || ':' || t.attname::text || ':'
                 || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ':'
                 || pg_catalog.pg_get_userbyid(a.grantor)::text || ':' || a.privilege_type || ':' || a.is_grantable::text
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_attribute t ON t.attrelid = c.oid AND t.attnum > 0 AND NOT t.attisdropped
            CROSS JOIN LATERAL aclexplode(t.attacl) a
           WHERE c.relnamespace = 'public'::regnamespace AND a.grantee IS DISTINCT FROM 'service_role'::regrole
             AND c.relname IN ('cloud_deal_messages', 'cloud_deal_files', 'cloud_blobs', 'mcp_settings', 'mcp_redirect_allowlist',
                               'mcp_oauth_clients', 'mcp_authorization_requests', 'mcp_connections', 'mcp_authorization_codes',
                               'mcp_tokens', 'mcp_rate_counters', 'mcp_call_log', 'cloud_deals', 'cloud_deal_parties',
                               'cloud_deal_checklists', 'cloud_deal_checklist_items', 'cloud_autosave_settings', 'member_addons')) z;
  IF v_fp IS DISTINCT FROM current_setting('keepr.m4265_other_acl', true) THEN
    v_bad := v_bad || 'ACL entries of other roles changed; ';
  END IF;
  IF v_bad <> '' THEN
    RAISE EXCEPTION '4265 post-check: service_role holds or other roles changed: %', v_bad;
  END IF;
END
$post4265$;
