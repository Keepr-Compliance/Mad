-- BACKLOG-4236 harness helpers. Loaded after the migration, inside the same transaction.
-- Every id, name, address and value is invented. Ids are derived from a value chosen at random
-- for each run (__RUN__, filled by compose.py), so two runs never share an id.

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
  SELECT md5('__RUN__:' || n)::uuid
$h$;
CREATE FUNCTION pg_temp.h(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex')
$h$;

CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $h$;

-- Run one statement as a role. A SELECT returns its single value as text; any other statement
-- returns '"rows=<n>"'; an error returns 'ERR <sqlstate> <message>'. Own subtransaction.
CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $h$
DECLARE j jsonb; n bigint;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
    PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', r, true);
    EXECUTE format('SET LOCAL ROLE %I', r);
    IF q ~* '^\s*(select|with)\M' THEN
      EXECUTE q INTO j;
    ELSE
      EXECUTE q; GET DIAGNOSTICS n = ROW_COUNT; j := to_jsonb('rows=' || n);
    END IF;
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.clear_claims();
    RETURN coalesce(j::text, 'null');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.clear_claims();
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;
END $h$;

CREATE FUNCTION pg_temp.j(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $h$
BEGIN RETURN t::jsonb; EXCEPTION WHEN OTHERS THEN RETURN NULL; END $h$;
CREATE FUNCTION pg_temp.err(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(pg_temp.j(t) ->> 'error', CASE WHEN pg_temp.j(t) ->> 'ok' = 'true' OR pg_temp.j(t) ->> 'success' = 'true' THEN 'OK' ELSE left(t, 200) END)
$h$;
-- status of result row n (0-based) of an upsert or tombstone envelope; 'reason' appended when rejected
CREATE FUNCTION pg_temp.st(t text, n int DEFAULT 0) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN pg_temp.j(t) ->> 'ok' = 'true'
              THEN (pg_temp.j(t) -> 'results' -> n ->> 'status') || coalesce(':' || (pg_temp.j(t) -> 'results' -> n ->> 'reason'), '')
              ELSE 'ERROR:' || pg_temp.err(t) END
$h$;
CREATE FUNCTION pg_temp.cid(t text, n int DEFAULT 0) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
  SELECT (pg_temp.j(t) -> 'results' -> n ->> 'cloud_id')::uuid
$h$;
CREATE FUNCTION pg_temp.pass(c boolean, detail text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN coalesce(c, false) THEN 'PASS' ELSE 'FAIL: ' || coalesce(left(detail, 500), '-') END
$h$;

-- API calls
CREATE FUNCTION pg_temp.state(u uuid) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, 'SELECT public.get_my_cloud_autosave_state()'))
$h$;
CREATE FUNCTION pg_temp.onoff(u uuid, en boolean, nv integer DEFAULT 1) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.set_my_cloud_autosave(%L::boolean, %L::integer)', en, nv))
$h$;
CREATE FUNCTION pg_temp.deal(u uuid, payload jsonb) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.cloud_upsert_deal(%L::jsonb)', payload))
$h$;
CREATE FUNCTION pg_temp.up(u uuid, fn text, inst uuid, deal uuid, rows jsonb) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.%I(%L::uuid, %L::uuid, %L::jsonb)', fn, inst, deal, rows))
$h$;
CREATE FUNCTION pg_temp.tomb(u uuid, inst uuid, kind text, ids uuid[]) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.cloud_tombstone(%L::uuid, %L, %L::uuid[])', inst, kind, ids))
$h$;
CREATE FUNCTION pg_temp.assign(org uuid, u uuid, on_ boolean, ends timestamptz DEFAULT NULL) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(NULL, format('SELECT public.assign_member_addon(%L::uuid, %L::uuid, %L, %L::boolean, %L::timestamptz)',
                                      org, u, 'cloud_autosave', on_, ends), 'service_role')
$h$;
-- one row of each kind, minimal valid payload; k makes the content (and the hash) differ
CREATE FUNCTION pg_temp.row_of(fn text, lid text, k text DEFAULT 'a') RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE fn
    WHEN 'cloud_upsert_parties' THEN jsonb_build_object('local_id', lid, 'content_hash', pg_temp.h(lid || k), 'display_name', 'Party ' || k)
    WHEN 'cloud_upsert_checklists' THEN jsonb_build_object('local_id', lid, 'content_hash', pg_temp.h(lid || k), 'template_id', 'tpl-' || k)
    WHEN 'cloud_upsert_checklist_items' THEN jsonb_build_object('local_id', lid, 'content_hash', pg_temp.h(lid || k), 'local_checklist_id', 'cl-1', 'title', 'Item ' || k)
    WHEN 'cloud_upsert_messages' THEN jsonb_build_object('local_id', lid, 'content_hash', pg_temp.h(lid || k), 'channel_kind', 'email', 'hidden_from_export', false, 'subject', 'Subject ' || k)
    WHEN 'cloud_upsert_files' THEN jsonb_build_object('local_id', lid, 'content_hash', pg_temp.h(lid || k), 'filename', 'file-' || k || '.pdf')
  END
$h$;
CREATE FUNCTION pg_temp.rows_of(fn text, n int, prefix text DEFAULT 'r') RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(jsonb_agg(pg_temp.row_of(fn, prefix || g)), '[]'::jsonb) FROM generate_series(1, n) g
$h$;
