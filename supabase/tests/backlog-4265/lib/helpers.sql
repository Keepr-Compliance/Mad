-- BACKLOG-4265 harness helpers (loaded after backlog-4263-sync2-t/lib/helpers.sql, whose rec, put, s, f, j, pass,
-- call_as, clear_claims, as_user, getm and lst they use). Inside the one call, which ends in RAISE.
CREATE TEMP TABLE t65_rel (blk text NOT NULL, name text PRIMARY KEY, kind "char" NOT NULL) ON COMMIT DROP;
INSERT INTO pg_temp.t65_rel VALUES
  ('A', 'cloud_deal_messages', 'r'), ('A', 'cloud_deal_files', 'r'), ('A', 'cloud_blobs', 'r'),
  ('B', 'mcp_settings', 'r'), ('B', 'mcp_redirect_allowlist', 'r'), ('B', 'mcp_oauth_clients', 'r'),
  ('B', 'mcp_authorization_requests', 'r'), ('B', 'mcp_connections', 'r'), ('B', 'mcp_authorization_codes', 'r'),
  ('B', 'mcp_tokens', 'r'), ('B', 'mcp_rate_counters', 'r'), ('B', 'mcp_call_log', 'r'), ('B', 'mcp_call_log_id_seq', 'S'),
  ('C', 'cloud_deals', 'r'), ('C', 'cloud_deal_parties', 'r'), ('C', 'cloud_deal_checklists', 'r'),
  ('C', 'cloud_deal_checklist_items', 'r'), ('C', 'cloud_autosave_settings', 'r'), ('C', 'member_addons', 'r');
CREATE TEMP TABLE t65_txt (k text PRIMARY KEY, v text NOT NULL) ON COMMIT DROP;
CREATE FUNCTION pg_temp.tx65(k text) RETURNS text LANGUAGE sql STABLE AS $h$ SELECT v FROM pg_temp.t65_txt WHERE t65_txt.k = tx65.k $h$;
-- the table privilege types of this server (MAINTAIN from PostgreSQL 17)
CREATE FUNCTION pg_temp.privs65() RETURNS text[] LANGUAGE sql STABLE AS $h$
  SELECT ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
         || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END
$h$;
-- the sorted service_role ACL items of relation n: grantor:privilege:grantable,...
CREATE FUNCTION pg_temp.sr_acl65(n text) RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT coalesce(string_agg(pg_catalog.pg_get_userbyid(a.grantor)::text || ':' || a.privilege_type || ':' || a.is_grantable::text, ','
                             ORDER BY a.privilege_type COLLATE "C", pg_catalog.pg_get_userbyid(a.grantor)::text COLLATE "C"), '')
    FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
   WHERE c.oid = pg_catalog.to_regclass('public.' || n) AND a.grantee = 'service_role'::regrole
$h$;
-- the ACL items (table and column) of every role except service_role on the 19 relations, as one md5
CREATE FUNCTION pg_temp.other_acl65() RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT md5(coalesce(string_agg(z.s, '|' ORDER BY z.s COLLATE "C"), '')) FROM (
    SELECT x.name || '::' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ':'
           || pg_catalog.pg_get_userbyid(a.grantor)::text || ':' || a.privilege_type || ':' || a.is_grantable::text AS s
      FROM pg_temp.t65_rel x JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass('public.' || x.name)
      CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE a.grantee IS DISTINCT FROM 'service_role'::regrole
    UNION ALL
    SELECT x.name || ':' || t.attname::text || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ':'
           || pg_catalog.pg_get_userbyid(a.grantor)::text || ':' || a.privilege_type || ':' || a.is_grantable::text
      FROM pg_temp.t65_rel x JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass('public.' || x.name)
      JOIN pg_catalog.pg_attribute t ON t.attrelid = c.oid AND t.attnum > 0 AND NOT t.attisdropped
      CROSS JOIN LATERAL aclexplode(t.attacl) a WHERE a.grantee IS DISTINCT FROM 'service_role'::regrole) z
$h$;
-- the non-owner, non-service_role ACL items of relation n: grantee:privilege,...
CREATE FUNCTION pg_temp.api_acl65(n text) RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT coalesce(string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ':' || a.privilege_type, ','
                             ORDER BY 1), '')
    FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
   WHERE c.oid = pg_catalog.to_regclass('public.' || n) AND a.grantee IS DISTINCT FROM c.relowner AND a.grantee IS DISTINCT FROM 'service_role'::regrole
$h$;
-- EXECUTE grants of every public function whose source names one of the 19 relations or a message reader, as one md5
CREATE FUNCTION pg_temp.fn_exec65() RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT md5(coalesce(string_agg(p.oid::regprocedure::text || ':' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || ':'
                                 || has_function_privilege('anon', p.oid, 'EXECUTE')::text || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                                 || ':' || has_function_privilege('public', p.oid, 'EXECUTE')::text || ':' || p.prosecdef::text,
                                 '|' ORDER BY p.oid::regprocedure::text COLLATE "C"), ''))
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND (p.prosrc ~ '_mcp_r_(get_message|list_deal_messages)' OR EXISTS (SELECT 1 FROM pg_temp.t65_rel x WHERE position(x.name IN p.prosrc) > 0))
$h$;
-- the names of those functions service_role can execute (report only)
CREATE FUNCTION pg_temp.fn_sr65() RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT coalesce(jsonb_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C"), '[]')
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('service_role', p.oid, 'EXECUTE')
     AND (p.prosrc ~ '_mcp_r_(get_message|list_deal_messages)' OR EXISTS (SELECT 1 FROM pg_temp.t65_rel x WHERE position(x.name IN p.prosrc) > 0))
$h$;
CREATE FUNCTION pg_temp.default_acl65() RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT md5(coalesce(string_agg(d.defaclrole::regrole::text || ':' || d.defaclnamespace::text || ':' || d.defaclobjtype::text || ':'
                                 || coalesce((SELECT string_agg(x.item::text, ',' ORDER BY x.item::text COLLATE "C") FROM unnest(d.defaclacl) x(item)), ''),
                                 '|' ORDER BY d.defaclrole::regrole::text COLLATE "C", d.defaclnamespace, d.defaclobjtype), ''))
    FROM pg_catalog.pg_default_acl d
$h$;
-- one statement as service_role (claims set, current_user asserted). 'ok', 'ERR <sqlstate>', or 'ROLE <who>' when the
-- role did not change.
CREATE FUNCTION pg_temp.sr_exec65(q text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE who text;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    SET LOCAL ROLE service_role;
    who := current_user;
    IF who IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'ROLE %', who;
    END IF;
    EXECUTE q;
    RESET ROLE;
    PERFORM pg_temp.clear_claims();
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.clear_claims();
    IF SQLERRM LIKE 'ROLE %' THEN RETURN SQLERRM; END IF;
    RETURN 'ERR ' || SQLSTATE;
  END;
END $h$;
-- every relation of the given blocks still granting service_role something (any type, column, or ACL entry)
CREATE FUNCTION pg_temp.sr_holds65(blocks text[]) RETURNS text[] LANGUAGE plpgsql VOLATILE AS $h$
DECLARE r record; out text[] := '{}';
BEGIN
  FOR r IN SELECT x.name, x.kind, pg_catalog.to_regclass('public.' || x.name) AS oid FROM pg_temp.t65_rel x
            WHERE x.blk = ANY (blocks) ORDER BY x.name COLLATE "C" LOOP
    IF r.oid IS NULL THEN
      out := out || (r.name || ':missing');
    ELSIF pg_temp.sr_acl65(r.name) <> ''
       OR (r.kind = 'S' AND (has_sequence_privilege('service_role', r.oid, 'USAGE') OR has_sequence_privilege('service_role', r.oid, 'SELECT')
                             OR has_sequence_privilege('service_role', r.oid, 'UPDATE')))
       OR (r.kind = 'r' AND (EXISTS (SELECT 1 FROM unnest(pg_temp.privs65()) p WHERE has_table_privilege('service_role', r.oid, p))
                             OR has_any_column_privilege('service_role', r.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))) THEN
      out := out || r.name;
    END IF;
  END LOOP;
  RETURN out;
END $h$;
-- SELECT, INSERT, UPDATE and DELETE (each matching no row) as service_role on every table of the given blocks; the
-- statements that did not end in 42501, as table:statement=result
CREATE FUNCTION pg_temp.sr_statements65(blocks text[]) RETURNS text[] LANGUAGE plpgsql VOLATILE AS $h$
DECLARE r record; col text; q text; res text; out text[] := '{}';
BEGIN
  FOR r IN SELECT x.name, pg_catalog.to_regclass('public.' || x.name) AS oid FROM pg_temp.t65_rel x
            WHERE x.blk = ANY (blocks) AND x.kind = 'r' ORDER BY x.name COLLATE "C" LOOP
    col := (SELECT quote_ident(a.attname) FROM pg_catalog.pg_attribute a
             WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attidentity = '' AND a.attgenerated = ''
             ORDER BY a.attnum LIMIT 1);
    FOREACH q IN ARRAY ARRAY[format('SELECT count(*) FROM public.%I', r.name),
                             format('INSERT INTO public.%I OVERRIDING SYSTEM VALUE SELECT * FROM public.%I WHERE false', r.name, r.name),
                             format('UPDATE public.%I SET %s = %s WHERE false', r.name, col, col),
                             format('DELETE FROM public.%I WHERE false', r.name)] LOOP
      res := pg_temp.sr_exec65(q);
      IF res IS DISTINCT FROM 'ERR 42501' THEN
        out := out || (r.name || ':' || split_part(q, ' ', 1) || '=' || res);
      END IF;
    END LOOP;
  END LOOP;
  RETURN out;
END $h$;
-- rows of the A, B and C tables and auth.users that existed before the fixtures. Left out: mcp_settings (the fixtures
-- set its one row for this call), mcp_rate_counters (a tool call deletes counter windows older than one day, of any
-- bucket), and mcp_authorization_requests rows already expired.
CREATE FUNCTION pg_temp.row_hashes65() RETURNS TABLE (t text, h text) LANGUAGE sql VOLATILE AS $h$
  SELECT 'cloud_deal_messages'::text, md5(x::text) FROM public.cloud_deal_messages x
  UNION ALL SELECT 'cloud_deal_files', md5(x::text) FROM public.cloud_deal_files x
  UNION ALL SELECT 'cloud_blobs', md5(x::text) FROM public.cloud_blobs x
  UNION ALL SELECT 'mcp_redirect_allowlist', md5(x::text) FROM public.mcp_redirect_allowlist x
  UNION ALL SELECT 'mcp_oauth_clients', md5(x::text) FROM public.mcp_oauth_clients x
  UNION ALL SELECT 'mcp_authorization_requests', md5(x::text) FROM public.mcp_authorization_requests x WHERE x.expires_at >= now()
  UNION ALL SELECT 'mcp_connections', md5(x::text) FROM public.mcp_connections x
  UNION ALL SELECT 'mcp_authorization_codes', md5(x::text) FROM public.mcp_authorization_codes x
  UNION ALL SELECT 'mcp_tokens', md5(x::text) FROM public.mcp_tokens x
  UNION ALL SELECT 'mcp_call_log', md5(x::text) FROM public.mcp_call_log x
  UNION ALL SELECT 'cloud_deals', md5(x::text) FROM public.cloud_deals x
  UNION ALL SELECT 'cloud_deal_parties', md5(x::text) FROM public.cloud_deal_parties x
  UNION ALL SELECT 'cloud_deal_checklists', md5(x::text) FROM public.cloud_deal_checklists x
  UNION ALL SELECT 'cloud_deal_checklist_items', md5(x::text) FROM public.cloud_deal_checklist_items x
  UNION ALL SELECT 'cloud_autosave_settings', md5(x::text) FROM public.cloud_autosave_settings x
  UNION ALL SELECT 'member_addons', md5(x::text) FROM public.member_addons x
  UNION ALL SELECT 'auth.users', md5(x::text) FROM auth.users x
$h$;
CREATE TEMP TABLE t65_pre ON COMMIT DROP AS SELECT * FROM pg_temp.row_hashes65();
CREATE FUNCTION pg_temp.foreign_rows65() RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  WITH now_ AS (SELECT * FROM pg_temp.row_hashes65()),
       tbls(t) AS (VALUES ('cloud_deal_messages'), ('cloud_deal_files'), ('cloud_blobs'), ('mcp_redirect_allowlist'), ('mcp_oauth_clients'),
                          ('mcp_authorization_requests'), ('mcp_connections'), ('mcp_authorization_codes'), ('mcp_tokens'), ('mcp_call_log'),
                          ('cloud_deals'), ('cloud_deal_parties'), ('cloud_deal_checklists'), ('cloud_deal_checklist_items'),
                          ('cloud_autosave_settings'), ('member_addons'), ('auth.users'))
  SELECT jsonb_object_agg(b.t, jsonb_build_object(
           'before', (SELECT count(*) FROM pg_temp.t65_pre p WHERE p.t = b.t),
           'gone_or_changed', (SELECT count(*) FROM pg_temp.t65_pre p WHERE p.t = b.t AND NOT EXISTS (SELECT 1 FROM now_ n WHERE n.t = p.t AND n.h = p.h))))
    FROM tbls b
$h$;
