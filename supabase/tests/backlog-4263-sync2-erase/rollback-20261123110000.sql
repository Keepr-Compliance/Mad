-- Rollback of 20261123110000_backlog_4263_cloud_blob_erase (BACKLOG-4263, sync plan P3, E1).
-- Run rollback-20261123120000.sql first (the schedule calls cloud_blob_erase_invoke()).
-- Removes the six functions, the two tables (run history is lost) and both vault secrets of the job
-- (cloud_blob_erase_secret, created by E1, and cloud_blob_erase_url, set per environment after E1).
-- Leaves cloud_blobs, cloud_deal_* rows and storage objects as they are: a blob fenced before the rollback stays
-- fenced and is erased once E1 is applied again.
-- One transaction; RAISEs (nothing changed) unless its pre-check and post-check hold. Refuses while the cron job
-- cloud-blob-erase exists, while any of the six functions is not at the body E1 wrote, and while
-- public.cloud_blob_erase_runs holds any row (the erase job's run history: keep a copy, then delete the rows first).
-- Not re-runnable: once it has run, the six functions are missing and the pre-check refuses (as the rollbacks of
-- 20261123130000 and 20261123140000 do).
-- Vault: only names and counts are read, never a secret value.
-- Locks (held until commit; lock_timeout 3s): ACCESS EXCLUSIVE on cloud_blob_erase_runs and cloud_blob_erase_leases
--   (dropped); the six functions' pg_proc rows; row locks on the two vault.secrets rows and the ledger row. The
--   pre-check and post-check count the rows of cloud_blobs and the cloud_deal* tables without locking rows.
-- lock_timeout 3s is set before the first statement.
SET LOCAL lock_timeout = '3s';
DO $rb4263e1$
DECLARE r record; v text; n bigint; b jsonb := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cloud-blob-erase') THEN
    RAISE EXCEPTION 'BACKLOG-4263 rollback E1: run rollback-20261123120000.sql first (cron job cloud-blob-erase exists)';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public.cloud_blob_erase_secret()', '5e1fc753469874c31f5a86a4f80655e6'),
      ('public.cloud_blob_erase_claim(boolean,integer,integer)', '3eac70008dafbee6985acb8f5a9e9ba8'),
      ('public.cloud_blob_erase_finish(uuid,uuid[],jsonb,text)', 'f4423f812a90172c431f0083805598be'),
      ('public.cloud_blob_erase_note(uuid,jsonb,text)', '2145d36a0cbb3ecffdf6df394d44af42'),
      ('public.cloud_blob_erase_scrub(uuid,uuid,boolean,integer)', '8ef3f7c2277b9c2e1be3e640ba45f676'),
      ('public.cloud_blob_erase_invoke()', '72fe4c0add8be193bab3eb384a40e5b4')) x(sig, want) LOOP
    SELECT md5(p.prosrc) INTO v FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(r.sig);
    IF v IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'ROLLBACK 20261123110000: % is not at the body 20261123110000 wrote (md5 %)', r.sig, coalesce(v, 'missing');
    END IF;
  END LOOP;
  IF pg_catalog.to_regclass('public.cloud_blob_erase_runs') IS NULL OR pg_catalog.to_regclass('public.cloud_blob_erase_leases') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK 20261123110000: a table of 20261123110000 is missing (cloud_blob_erase_runs or cloud_blob_erase_leases)';
  END IF;
  SELECT count(*) INTO n FROM public.cloud_blob_erase_runs;
  IF n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK 20261123110000: public.cloud_blob_erase_runs holds % rows (the erase job''s run history); keep a copy, then delete them first', n;
  END IF;
  -- what must not change: the row counts of cloud_blobs and every cloud_deal* table, and the other public functions
  FOR r IN SELECT c.relname::text AS t FROM pg_catalog.pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
              AND (c.relname::text = 'cloud_blobs' OR c.relname::text LIKE 'cloud\_deal%') ORDER BY 1 LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.t) INTO n;
    b := b || jsonb_build_object(r.t, n);
  END LOOP;
  b := b || jsonb_build_object('other_public_functions',
         (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname::text NOT IN
            ('cloud_blob_erase_secret', 'cloud_blob_erase_claim', 'cloud_blob_erase_finish', 'cloud_blob_erase_note',
             'cloud_blob_erase_scrub', 'cloud_blob_erase_invoke')));
  PERFORM set_config('rb4263e1.before', b::text, true);
  PERFORM set_config('rb4263e1.leases', (SELECT count(*) FROM public.cloud_blob_erase_leases)::text, true);
END
$rb4263e1$;
DROP FUNCTION IF EXISTS public.cloud_blob_erase_invoke();
DROP FUNCTION IF EXISTS public.cloud_blob_erase_scrub(uuid, uuid, boolean, integer);
DROP FUNCTION IF EXISTS public.cloud_blob_erase_note(uuid, jsonb, text);
DROP FUNCTION IF EXISTS public.cloud_blob_erase_finish(uuid, uuid[], jsonb, text);
DROP FUNCTION IF EXISTS public.cloud_blob_erase_claim(boolean, integer, integer);
DROP FUNCTION IF EXISTS public.cloud_blob_erase_secret();
DROP TABLE IF EXISTS public.cloud_blob_erase_leases;
DROP TABLE IF EXISTS public.cloud_blob_erase_runs;
DELETE FROM vault.secrets WHERE name IN ('cloud_blob_erase_secret', 'cloud_blob_erase_url');
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261123110000';
DO $postrb4263e1$
DECLARE r record; n bigint; a jsonb := '{}'; b jsonb := nullif(current_setting('rb4263e1.before', true), '')::jsonb; bad text := '';
BEGIN
  IF b IS NULL THEN
    bad := bad || 'no pre-check record; ';
  END IF;
  FOR r IN SELECT * FROM (VALUES ('public.cloud_blob_erase_secret()'), ('public.cloud_blob_erase_claim(boolean,integer,integer)'),
      ('public.cloud_blob_erase_finish(uuid,uuid[],jsonb,text)'), ('public.cloud_blob_erase_note(uuid,jsonb,text)'),
      ('public.cloud_blob_erase_scrub(uuid,uuid,boolean,integer)'), ('public.cloud_blob_erase_invoke()')) x(sig) LOOP
    IF pg_catalog.to_regprocedure(r.sig) IS NOT NULL THEN bad := bad || r.sig || ' still present; '; END IF;
  END LOOP;
  IF pg_catalog.to_regclass('public.cloud_blob_erase_runs') IS NOT NULL OR pg_catalog.to_regclass('public.cloud_blob_erase_leases') IS NOT NULL THEN
    bad := bad || 'a table still present; ';
  END IF;
  SELECT count(*) INTO n FROM vault.secrets WHERE name IN ('cloud_blob_erase_secret', 'cloud_blob_erase_url');
  IF n > 0 THEN bad := bad || n::text || ' vault row(s) of the job still present; '; END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations s WHERE s.version = '20261123110000') THEN
    bad := bad || 'ledger row still present; ';
  END IF;
  FOR r IN SELECT c.relname::text AS t FROM pg_catalog.pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
              AND (c.relname::text = 'cloud_blobs' OR c.relname::text LIKE 'cloud\_deal%') ORDER BY 1 LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.t) INTO n;
    a := a || jsonb_build_object(r.t, n);
  END LOOP;
  a := a || jsonb_build_object('other_public_functions',
         (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname::text NOT IN
            ('cloud_blob_erase_secret', 'cloud_blob_erase_claim', 'cloud_blob_erase_finish', 'cloud_blob_erase_note',
             'cloud_blob_erase_scrub', 'cloud_blob_erase_invoke')));
  IF a IS DISTINCT FROM b THEN
    bad := bad || 'other rows or functions changed: before ' || coalesce(b::text, 'none') || ', after ' || a::text || '; ';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'ROLLBACK POST-CHECK 20261123110000 FAILED, nothing changed: %', bad;
  END IF;
  RAISE NOTICE 'ROLLBACK POST-CHECK 20261123110000 OK: counts unchanged %, lease rows dropped %', a, current_setting('rb4263e1.leases', true);
END
$postrb4263e1$;
