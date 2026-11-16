-- BACKLOG-3986 DB controls: public.scim_tokens and public.scim_sync_log row-level policies.
-- Venue: keepr-test ONLY (kt-sql refuses the production ref). Run through run.sh, which composes
-- ONE call: BEGIN; [migration file | mutated ALTER | nothing]; this file. This file ends in a RAISE
-- EXCEPTION carrying the result, on pass AND on fail, so the transaction always rolls back and
-- nothing persists (the management API returns only the error text, which is how the result is read).
-- Fixtures (invented): ids fx(n) = 00000000-0000-3986-8000-<n>, emails p3986-<n>@example.test.
--   org A, org B (brokerages, no plan)
--   u1 admin    A active          u2 it_admin A active        u3 agent A active
--   u4 admin    B active          u5 admin    A suspended
--   one seeded token and one seeded sync-log row in each org.
-- Controls (as role authenticated, request.jwt.claims sub = the user):
--   P1 u1 insert / select / revoke-update on A           -> allowed
--   P2 u2 the same                                       -> allowed
--   N1 u3 insert refused 42501, sees 0, updates 0
--   N2 u4 insert for A refused, sees 0 of A, updates 0 of A; sanity: sees its own B token
--   N3 u5 insert refused, sees 0, updates 0
--   S-* the same five personas on scim_sync_log SELECT
-- Output: RAISE 'P3986_RESULT {total, pass, fail, reds, mutation}'.

DO $drv$
DECLARE
  oA uuid; oB uuid;
  r jsonb := '[]'::jsonb;
  v text;
  m text;
BEGIN
  EXECUTE $f$CREATE OR REPLACE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
    SELECT ('00000000-0000-3986-8000-' || lpad(n::text, 12, '0'))::uuid
  $b$$f$;

  -- run one statement as authenticated user u; a SELECT/WITH returns its jsonb value as text,
  -- anything else '"ok"', an error 'ERR <sqlstate>'. Each call is its own subtransaction.
  EXECUTE $f$CREATE OR REPLACE FUNCTION pg_temp.call_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE j jsonb;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      SET LOCAL ROLE authenticated;
      IF q ~* '^\s*(select|with)\M' THEN
        EXECUTE q INTO j;
      ELSE
        EXECUTE q;
        j := '"ok"'::jsonb;
      END IF;
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      RETURN coalesce(j::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      RETURN 'ERR ' || SQLSTATE;
    END;
  END $b$$f$;

  oA := pg_temp.fx(101);
  oB := pg_temp.fx(102);

  -- fixtures, as the connecting role (table owner; RLS not forced)
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p3986-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM generate_series(1, 5) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p3986-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P3986 user ' || x
    FROM generate_series(1, 5) x
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;
  INSERT INTO public.organizations (id, name, slug) VALUES
    (oA, 'P3986 A', 'p3986-a'), (oB, 'P3986 B', 'p3986-b');
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES
    (oA, pg_temp.fx(1), 'admin',    'active'),
    (oA, pg_temp.fx(2), 'it_admin', 'active'),
    (oA, pg_temp.fx(3), 'agent',    'active'),
    (oB, pg_temp.fx(4), 'admin',    'active'),
    (oA, pg_temp.fx(5), 'admin',    'suspended');
  INSERT INTO public.scim_tokens (id, organization_id, token_hash, description) VALUES
    (pg_temp.fx(201), oA, 'p3986-seed-a', 'p3986 seed A'),
    (pg_temp.fx(202), oB, 'p3986-seed-b', 'p3986 seed B');
  INSERT INTO public.scim_sync_log (organization_id, operation, resource_type) VALUES
    (oA, 'p3986', 'User'), (oB, 'p3986', 'User');

  CREATE TEMP TABLE IF NOT EXISTS _p3986_mut (label text, qual text);
  SELECT string_agg(label || ': ' || qual, ' | ') INTO m FROM _p3986_mut;

  -- helper SQL, per persona n
  -- ins: insert a token for org A as user n
  -- sel: count of org A tokens visible
  -- upd: count of org A tokens a revoke-update touches
  DECLARE
    n int;
    ins text; sel text; upd text; lsel text;
    expect_ok boolean;
    lbl text;
  BEGIN
    FOR n IN 1..5 LOOP
      lbl := CASE n WHEN 1 THEN 'P1' WHEN 2 THEN 'P2' WHEN 3 THEN 'N1' WHEN 4 THEN 'N2' ELSE 'N3' END;
      expect_ok := n IN (1, 2);
      ins := format($q$INSERT INTO public.scim_tokens (organization_id, token_hash, description, created_by)
                       VALUES (%L, %L, 'p3986', %L)$q$, oA, 'p3986-ins-' || n, pg_temp.fx(n));
      sel := format($q$SELECT to_jsonb(count(*)) FROM public.scim_tokens WHERE organization_id = %L$q$, oA);
      upd := format($q$WITH x AS (UPDATE public.scim_tokens SET revoked_at = now()
                                  WHERE organization_id = %L AND id = %L RETURNING 1)
                       SELECT to_jsonb(count(*)) FROM x$q$, oA, pg_temp.fx(201));
      lsel := format($q$SELECT to_jsonb(count(*)) FROM public.scim_sync_log WHERE organization_id = %L$q$, oA);

      v := pg_temp.call_as(pg_temp.fx(n), ins);
      r := r || jsonb_build_object('c', lbl || '-insert', 'got', v,
             'ok', CASE WHEN expect_ok THEN v = '"ok"' ELSE v = 'ERR 42501' END);

      v := pg_temp.call_as(pg_temp.fx(n), sel);
      -- allowed personas see the seed plus every row inserted so far (>= 2); refused see 0
      r := r || jsonb_build_object('c', lbl || '-select', 'got', v,
             'ok', CASE WHEN expect_ok THEN v ~ '^[0-9]+$' AND v::int >= 2 ELSE v = '0' END);

      v := pg_temp.call_as(pg_temp.fx(n), upd);
      r := r || jsonb_build_object('c', lbl || '-revoke', 'got', v,
             'ok', CASE WHEN expect_ok THEN v = '1' ELSE v = '0' END);

      v := pg_temp.call_as(pg_temp.fx(n), lsel);
      r := r || jsonb_build_object('c', 'S-' || lbl || '-select', 'got', v,
             'ok', CASE WHEN expect_ok THEN v = '1' ELSE v = '0' END);
    END LOOP;

    -- N2 sanity: the other-org admin is a working admin of its own org
    v := pg_temp.call_as(pg_temp.fx(4),
           format($q$SELECT to_jsonb(count(*)) FROM public.scim_tokens WHERE organization_id = %L$q$, oB));
    r := r || jsonb_build_object('c', 'N2-sanity-own-org-select', 'got', v, 'ok', v = '1');
    v := pg_temp.call_as(pg_temp.fx(4),
           format($q$SELECT to_jsonb(count(*)) FROM public.scim_sync_log WHERE organization_id = %L$q$, oB));
    r := r || jsonb_build_object('c', 'S-N2-sanity-own-org-select', 'got', v, 'ok', v = '1');
    -- the rows the allowed personas inserted actually landed (as owner, bypassing RLS)
    SELECT count(*)::text INTO v FROM public.scim_tokens WHERE organization_id = oA AND token_hash LIKE 'p3986-ins-%';
    r := r || jsonb_build_object('c', 'inserted-rows-landed', 'got', v, 'ok', v = '2');
  END;

  RAISE EXCEPTION 'P3986_RESULT %', jsonb_build_object(
    'total', jsonb_array_length(r),
    'pass', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'ok')::boolean),
    'fail', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE NOT (e->>'ok')::boolean),
    'reds', (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(r) e WHERE NOT (e->>'ok')::boolean),
    'mutation', coalesce(m, 'none'));
END
$drv$;
