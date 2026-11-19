-- BACKLOG-4263 mcp_authorize_view age harness: helpers and fixtures, loaded BEFORE the migration (inside the same
-- rolled-back call). Every id, name, address and secret is invented and derived from 'age-harness'. Rows of other
-- users are never read or written. Requests are inserted with the columns mcp_authorize_begin writes
-- (expires_at = created_at + 180 s), with chosen created_at values relative to now() (the transaction time).

CREATE TEMP TABLE ag_out (o serial, k text, v jsonb);
CREATE FUNCTION pg_temp.rec(p_k text, p_v jsonb) RETURNS void LANGUAGE sql AS $h$ INSERT INTO pg_temp.ag_out (k, v) VALUES (p_k, p_v) $h$;
CREATE TEMP TABLE ag_fx (fk text PRIMARY KEY, fv text);
CREATE FUNCTION pg_temp.id(p_k text) RETURNS uuid LANGUAGE sql STABLE AS $h$ SELECT f.fv::uuid FROM pg_temp.ag_fx f WHERE f.fk = p_k $h$;
CREATE FUNCTION pg_temp.put(p_k text, p_v text) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.ag_fx (fk, fv) VALUES (p_k, p_v) ON CONFLICT (fk) DO UPDATE SET fv = excluded.fv $h$;

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$ SELECT md5('p4263:age-harness:' || n)::uuid $h$;
CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $h$;
-- One SELECT as an API role with the user's claims (own subtransaction); returns the value as text, or
-- 'ERR <sqlstate> <message>'.
CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $h$
DECLARE j jsonb;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
    PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', r, true);
    EXECUTE format('SET LOCAL ROLE %I', r);
    EXECUTE q INTO j;
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.clear_claims();
    RETURN coalesce(j::text, 'null');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.clear_claims();
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 200);
  END;
END $h$;
CREATE FUNCTION pg_temp.j(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $h$
BEGIN RETURN t::jsonb; EXCEPTION WHEN OTHERS THEN RETURN to_jsonb(t); END $h$;
CREATE FUNCTION pg_temp.pass(c boolean, detail text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN coalesce(c, false) THEN 'PASS' ELSE 'FAIL: ' || coalesce(left(detail, 600), '-') END
$h$;
CREATE FUNCTION pg_temp.all_of(r text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN bool_and(x = 'PASS') THEN 'PASS'
              ELSE 'FAIL: ' || string_agg(CASE WHEN x <> 'PASS' THEN '#' || o || ' ' || x END, ' | ') END
    FROM unnest(r) WITH ORDINALITY t(x, o)
$h$;

CREATE FUNCTION pg_temp.client() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'kpr_c_' || substr(md5('age-harness-client'), 1, 22) $h$;
CREATE FUNCTION pg_temp.rid(p_k text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT substr(md5('age-harness-req-' || p_k), 1, 22) $h$;
CREATE FUNCTION pg_temp.bind(p_k text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $h$ SELECT sha256(convert_to('age-harness-bind-' || p_k, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.bindl(p_k text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT '\x' || encode(pg_temp.bind(p_k), 'hex') $h$;
CREATE FUNCTION pg_temp.cl() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://claude.ai/api/mcp/auth_callback' $h$;
CREATE FUNCTION pg_temp.gp() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://chatgpt.com/connector_platform_oauth_redirect' $h$;

-- a request: created_at = now() + p_off; expires_at = created_at + 180 s unless p_exp is given
CREATE FUNCTION pg_temp.req(p_k text, p_off interval, p_redirect text, p_scope text, p_status text DEFAULT 'pending',
                            p_claim uuid DEFAULT NULL, p_exp interval DEFAULT NULL) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO public.mcp_authorization_requests (id, client_id, redirect_uri, code_challenge, resource, scope, state,
                                                 browser_binding_sha256, status, claimed_by, created_at, expires_at)
  VALUES (pg_temp.rid(p_k), pg_temp.client(), p_redirect, substr(md5('age-cc-' || p_k) || md5('age-cc2-' || p_k), 1, 43),
          'https://age-fixture.example.test/api/mcp', p_scope, NULL, pg_temp.bind(p_k), p_status, p_claim,
          now() + p_off, now() + p_off + coalesce(p_exp, interval '180 seconds'))
$h$;

-- the view as user u (NULL = no user) through role r; p_fn lets the old body under its temporary name be called
CREATE FUNCTION pg_temp.view_as(u uuid, p_k text, p_bind text DEFAULT NULL, p_fn text DEFAULT 'mcp_authorize_view',
                                r text DEFAULT 'authenticated') RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, format('SELECT public.%I(%L, %L::bytea)', p_fn, pg_temp.rid(p_k),
                                             coalesce(p_bind, pg_temp.bindl(p_k))), r))
$h$;

-- one view in its own rolled-back subtransaction: the answer and the request row it leaves behind
CREATE FUNCTION pg_temp.one(p_fn text, p_k text, u uuid, p_bind text, p_writes boolean, p_off boolean) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE v_ans jsonb; v_row jsonb;
BEGIN
  BEGIN
    IF p_writes THEN UPDATE public.mcp_write_settings w SET writes_enabled = true WHERE w.id; END IF;
    IF p_off THEN UPDATE public.mcp_settings s SET enabled = false WHERE s.id; END IF;
    v_ans := pg_temp.view_as(u, p_k, p_bind, p_fn);
    SELECT jsonb_build_object('claimed_by', q.claimed_by, 'scope', q.scope, 'status', q.status,
             'nonce_stored_matches', q.consent_nonce_sha256 IS NOT DISTINCT FROM
               (CASE WHEN v_ans ? 'nonce' THEN sha256(convert_to(v_ans ->> 'nonce', 'UTF8')) END))
      INTO v_row FROM public.mcp_authorization_requests q WHERE q.id = pg_temp.rid(p_k);
    RAISE EXCEPTION USING ERRCODE = 'MX003';
  EXCEPTION WHEN SQLSTATE 'MX003' THEN NULL;
  END;
  RETURN jsonb_build_object('answer', v_ans, 'row', v_row);
END $h$;

-- the comparison and refusal cases: case, request key, who (A or none), binding of another key, writes on, mcp off,
-- success expected, refusal code expected
CREATE TEMP TABLE ag_cases (ck text PRIMARY KEY, rk text, who text, bk text, wr boolean, off_ boolean, ok_ boolean, code text);
INSERT INTO pg_temp.ag_cases VALUES
  ('E_read_new',   'E_read_new',   'A', NULL, false, false, true,  NULL),
  ('E_read_repl',  'E_read_repl',  'A', NULL, false, false, true,  NULL),
  ('E_todos_new',  'E_todos_new',  'A', NULL, true,  false, true,  NULL),
  ('E_todos_repl', 'E_todos_repl', 'A', NULL, true,  false, true,  NULL),
  ('E_age_179',    'R179',         'A', NULL, false, false, true,  NULL),
  ('X_other_user', 'X_other_user', 'A', NULL, false, false, false, 'request_invalid'),
  ('X_unknown',    'X_unknown',    'A', NULL, false, false, false, 'request_invalid'),
  ('X_expired',    'X_expired',    'A', NULL, false, false, false, 'request_invalid'),
  ('X_approved',   'X_approved',   'A', NULL, false, false, false, 'request_invalid'),
  ('X_denied',     'X_denied',     'A', NULL, false, false, false, 'request_invalid'),
  ('X_binding',    'R40',          'A', 'R1', false, false, false, 'request_invalid'),
  ('X_no_user',    'R40',          NULL, NULL, false, false, false, 'not_signed_in'),
  ('X_disabled',   'R40',          'A', NULL, false, true,  false, 'disabled');

DO $fxage$
DECLARE v_a uuid := pg_temp.fx(1); v_b uuid := pg_temp.fx(2);
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(n), 'p4263-age-' || substr(md5('age-harness'), 1, 8) || '-' || n || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM generate_series(1, 2) n;
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.put('A', v_a::text);
  PERFORM pg_temp.put('B', v_b::text);
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES (pg_temp.client(), 'Fixture app', ARRAY[pg_temp.cl(), pg_temp.gp()], sha256(convert_to('age-harness-ip', 'UTF8')));
  -- A already has an active connection on the claude redirect: a request on that redirect replaces it
  INSERT INTO public.mcp_connections (id, user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status, activated_at)
  VALUES (md5('age-harness-conn')::uuid, v_a, pg_temp.client(), 'anthropic', 'Fixture app', pg_temp.cl(),
          'https://age-fixture.example.test/api/mcp', 'mcp:read', 1, 'active', now());
  -- ages
  PERFORM pg_temp.req('R0', interval '0 seconds', pg_temp.gp(), 'mcp:read');
  PERFORM pg_temp.req('R0999', interval '-0.999 seconds', pg_temp.gp(), 'mcp:read');
  PERFORM pg_temp.req('R1', interval '-1 second', pg_temp.gp(), 'mcp:read');
  PERFORM pg_temp.req('R40', interval '-40 seconds', pg_temp.gp(), 'mcp:read');
  PERFORM pg_temp.req('R406', interval '-40.6 seconds', pg_temp.gp(), 'mcp:read');
  PERFORM pg_temp.req('R178999', interval '-178.999 seconds', pg_temp.gp(), 'mcp:read');
  PERFORM pg_temp.req('R179', interval '-179 seconds', pg_temp.gp(), 'mcp:read');
  -- created in the future (clock skew)
  PERFORM pg_temp.req('RF04', interval '0.4 seconds', pg_temp.gp(), 'mcp:read');
  PERFORM pg_temp.req('RF30', interval '30 seconds', pg_temp.gp(), 'mcp:read');
  -- old-vs-new: read and write scope, replacing and not
  PERFORM pg_temp.req('E_read_new', interval '-12 seconds', pg_temp.gp(), 'mcp:read');
  PERFORM pg_temp.req('E_read_repl', interval '-12 seconds', pg_temp.cl(), 'mcp:read');
  PERFORM pg_temp.req('E_todos_new', interval '-12 seconds', pg_temp.gp(), 'mcp:todos');
  PERFORM pg_temp.req('E_todos_repl', interval '-12 seconds', pg_temp.cl(), 'mcp:todos');
  -- refusals
  PERFORM pg_temp.req('X_other_user', interval '-5 seconds', pg_temp.gp(), 'mcp:read', 'pending', v_b);
  PERFORM pg_temp.req('X_expired', interval '-200 seconds', pg_temp.gp(), 'mcp:read');
  PERFORM pg_temp.req('X_approved', interval '-5 seconds', pg_temp.gp(), 'mcp:read', 'approved', v_a);
  PERFORM pg_temp.req('X_denied', interval '-5 seconds', pg_temp.gp(), 'mcp:read', 'denied', v_a);
  PERFORM pg_temp.rec('fx_requests', to_jsonb((SELECT count(*) FROM public.mcp_authorization_requests q WHERE q.client_id = pg_temp.client())));
  PERFORM pg_temp.rec('fx_mcp_enabled', to_jsonb((SELECT s.enabled FROM public.mcp_settings s WHERE s.id)));
  PERFORM pg_temp.rec('fx_writes_enabled', to_jsonb((SELECT w.writes_enabled FROM public.mcp_write_settings w WHERE w.id)));
  PERFORM pg_temp.rec('fx_now', to_jsonb(now()));
END
$fxage$;
-- clock_timestamp() pulls away from now() (the transaction time) by more than a second before any control runs
DO $sleep$
BEGIN
  PERFORM pg_sleep(1.2);
  PERFORM pg_temp.rec('clock_gap_seconds', to_jsonb(extract(epoch FROM clock_timestamp() - now())));
END
$sleep$;
