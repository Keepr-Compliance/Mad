-- BACKLOG-3759 harness helpers (pg_temp, inside the run's transaction).
-- Fixture ids are derived from names (no id literals in this directory):
-- pg_temp.id('<name>') in SQL run as postgres, '{<name>}' inside statements
-- passed to pg_temp.run_as. Output maps ids back to {<name>}.
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT md5('backlog-3759:' || p_name)::uuid $f$;
CREATE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['o_main','o_other','u_agent','u_broker','u_outsider',
                      's_upl','s_sub','s_v2','m_sub','a_sub','c_sub']) $f$;
CREATE FUNCTION pg_temp.subst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, '{' || n || '}', pg_temp.id(n)::text); END LOOP;
  IF p ~ '\{[a-z_0-9]+\}' THEN RAISE EXCEPTION 'unknown fixture name in: %', p; END IF;
  RETURN p; END $f$;
CREATE FUNCTION pg_temp.unsubst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, pg_temp.id(n)::text, '{' || n || '}'); END LOOP;
  RETURN p; END $f$;

CREATE TEMP TABLE t3759_r (seq serial, label text, ok boolean, detail text) ON COMMIT DROP;

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO t3759_r (label, ok, detail) VALUES (p_label, coalesce(p_ok, false), pg_temp.unsubst(p_detail)) $f$;

-- Run `sql` as a PostgREST caller: p_role 'anon' (no user id) or
-- 'authenticated' (p_uid may be NULL for a token without a subject).
-- Returns 'OK rows=N' (rows returned or affected) or 'ERR <sqlstate> <message>'.
-- The statement's effect is always undone.
CREATE FUNCTION pg_temp.run_as(p_role text, p_uid uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int; msg text; st text;
BEGIN
  p_sql := pg_temp.subst(p_sql);
  BEGIN
    PERFORM set_config('request.jwt.claims',
      CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)
           ELSE json_build_object('sub', p_uid, 'role', p_role) END::text, true);
    PERFORM set_config('role', p_role, true);
    EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; msg := 'OK rows=' || n;
    PERFORM set_config('role', 'postgres', true);
    RAISE EXCEPTION 't3759_undo' USING DETAIL = msg;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 't3759_undo' THEN GET STACKED DIAGNOSTICS msg = PG_EXCEPTION_DETAIL;
    ELSE GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM; END IF;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN pg_temp.unsubst(msg);
END $f$;

-- check that run_as(...) returned exactly p_want ('OK rows=0', ...), or, when
-- p_want starts with '~', matches that regex.
CREATE FUNCTION pg_temp.expect(p_label text, p_role text, p_uid uuid, p_sql text, p_want text)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE got text := pg_temp.run_as(p_role, p_uid, p_sql);
BEGIN
  PERFORM pg_temp.check(p_label,
    CASE WHEN left(p_want, 1) = '~' THEN got ~ substr(p_want, 2) ELSE got = p_want END,
    'want ' || p_want || ' got ' || got);
END $f$;

-- The three read rules: 'table.policy roles md5(qual)', one per line.
CREATE FUNCTION pg_temp.rules() RETURNS text LANGUAGE sql AS $f$
  SELECT string_agg(tablename || '.' || policyname || ' ' || roles::text || ' ' || coalesce(md5(qual), '<null>'), '; ' ORDER BY tablename)
    FROM pg_policies
   WHERE schemaname = 'public' AND cmd = 'SELECT'
     AND (tablename, policyname) IN (('transaction_submissions', 'transaction_submissions_select_public'),
                                     ('submission_messages', 'message_access_via_submission'),
                                     ('submission_attachments', 'attachment_access_via_submission')) $f$;

-- The production values (2026-10-07, pg_policies on prod and on the NAS
-- after its catch-up to 20261004232511: identical).
CREATE FUNCTION pg_temp.rules_with(p_roles text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT 'submission_attachments.attachment_access_via_submission ' || p_roles || ' aadbffd22c8c8f2e7a7d440c3f45ddb7; '
      || 'submission_messages.message_access_via_submission ' || p_roles || ' 1363e5e79110edb649e6f63f8633652d; '
      || 'transaction_submissions.transaction_submissions_select_public ' || p_roles || ' eb31142ae1935bb013b94c5a837812a8' $f$;

-- EXECUTE for one role ('PUBLIC' = grantee 0 in the ACL).
CREATE FUNCTION pg_temp.can_exec(p_role text, p_fn text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT CASE WHEN p_role = 'PUBLIC' THEN
           EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    WHERE p.oid = p_fn::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
         ELSE has_function_privilege(p_role, p_fn::regprocedure, 'EXECUTE') END $f$;

CREATE FUNCTION pg_temp.acl(p_fn text) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(proacl::text, '<default>') FROM pg_proc WHERE oid = p_fn::regprocedure $f$;
