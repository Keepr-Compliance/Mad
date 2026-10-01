-- BACKLOG-3553 venue controls for 20260929074121_backlog_3553_storage_usage_execute.sql.
--
-- One transaction, ending in ROLLBACK. Three phases, each in a savepoint:
--   A  pre-state: EXECUTE held by PUBLIC, anon, authenticated and service_role
--   B  pre-state: EXECUTE held by PUBLIC only (service_role has no own entry)
--   C  pre-state: EXECUTE held by service_role only (migration already applied)
-- Each phase sets its pre-state, probes it, runs the migration text (spliced in
-- by run.sh at each "harness: migration" marker), probes again, and asserts:
-- anon and authenticated are denied, service_role returns the fixture row.
-- Fixture: one organization and one object in the function's bucket, synthetic ids.

\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
BEGIN;

INSERT INTO storage.buckets(id, name) VALUES ('submission-attachments', 'submission-attachments') ON CONFLICT DO NOTHING;
INSERT INTO public.organizations(id, name, slug)
  -- pii-allow-uuid: invented, not from any live row
  VALUES ('00000000-0000-4000-8000-00000000c553', 'Venue Org 3553', 'venue-org-3553');
INSERT INTO storage.objects(bucket_id, name, metadata)
  -- pii-allow-uuid: invented, not from any live row
  VALUES ('submission-attachments', '00000000-0000-4000-8000-00000000c553/f/a.pdf', '{"size":"1024"}');

CREATE FUNCTION pg_temp.call_as(r text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE n bigint; res text;
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', r);
  BEGIN
    SELECT count(*) INTO n FROM public.get_storage_usage()
      -- pii-allow-uuid: invented, not from any live row
      WHERE org_id = '00000000-0000-4000-8000-00000000c553';
    res := 'rows=' || n;
  EXCEPTION WHEN insufficient_privilege THEN res := 'DENIED';
  END;
  RESET ROLE;
  RETURN res;
END $$;

CREATE FUNCTION pg_temp.probe(ph text) RETURNS text LANGUAGE sql AS $$
  SELECT ph
    || ' anon=' || pg_temp.call_as('anon')
    || ' authenticated=' || pg_temp.call_as('authenticated')
    || ' service_role=' || pg_temp.call_as('service_role')
    || ' public_hfp=' || has_function_privilege('public', 'public.get_storage_usage()', 'EXECUTE')
$$;

CREATE FUNCTION pg_temp.expect_after(ph text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE a text := pg_temp.call_as('anon');
        u text := pg_temp.call_as('authenticated');
        s text := pg_temp.call_as('service_role');
        p boolean := has_function_privilege('public', 'public.get_storage_usage()', 'EXECUTE');
BEGIN
  IF a <> 'DENIED' OR u <> 'DENIED' OR s <> 'rows=1' OR p THEN
    RAISE EXCEPTION 'FAIL % anon=% authenticated=% service_role=% public_hfp=%', ph, a, u, s, p;
  END IF;
  RETURN 'PASS ' || ph;
END $$;

-- Phase A
SAVEPOINT a;
REVOKE EXECUTE ON FUNCTION public.get_storage_usage() FROM PUBLIC, anon, authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.get_storage_usage() TO PUBLIC, anon, authenticated, service_role;
SELECT pg_temp.probe('A_before');
-- harness: migration
SELECT pg_temp.probe('A_after');
SELECT pg_temp.expect_after('A');
ROLLBACK TO SAVEPOINT a;

-- Phase B
SAVEPOINT b;
REVOKE EXECUTE ON FUNCTION public.get_storage_usage() FROM PUBLIC, anon, authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.get_storage_usage() TO PUBLIC;
SELECT pg_temp.probe('B_before');
-- harness: migration
SELECT pg_temp.probe('B_after');
SELECT pg_temp.expect_after('B');
ROLLBACK TO SAVEPOINT b;

-- Phase C
SAVEPOINT c;
REVOKE EXECUTE ON FUNCTION public.get_storage_usage() FROM PUBLIC, anon, authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.get_storage_usage() TO service_role;
SELECT pg_temp.probe('C_before');
-- harness: migration
SELECT pg_temp.probe('C_after');
SELECT pg_temp.expect_after('C');
ROLLBACK TO SAVEPOINT c;

ROLLBACK;
