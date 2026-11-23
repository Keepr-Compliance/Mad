-- BACKLOG-4263 sync plan P3 controls. Each probe builds its own fixture and returns 'PASS' or 'FAIL <why>'.
-- harness.py runs each one in its own subtransaction, undone at its end; the whole call ends in RAISE.
-- The test database is shared: assertions are made on the fixture's own rows only, never on totals.

-- grants and role guard (P3 condition 3 second half; revoke by default)
CREATE FUNCTION pg_temp.p_grants() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE bad text := ''; f text; r text; t text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.cloud_blob_erase_secret()', 'public.cloud_blob_erase_claim(boolean,integer,integer)',
                           'public.cloud_blob_erase_finish(uuid,uuid[],jsonb,text)', 'public.cloud_blob_erase_scrub(uuid,uuid,boolean,integer)',
                           'public.cloud_blob_erase_note(uuid,jsonb,text)'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(r, f, 'EXECUTE') THEN bad := bad || r || ' runs ' || f || '; '; END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN bad := bad || 'service_role cannot run ' || f || '; '; END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN bad := bad || 'PUBLIC runs ' || f || '; '; END IF;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(r, 'public.cloud_blob_erase_invoke()', 'EXECUTE') THEN bad := bad || r || ' runs invoke; '; END IF;
    FOREACH t IN ARRAY ARRAY['public.cloud_blob_erase_runs', 'public.cloud_blob_erase_leases'] LOOP
      IF has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN bad := bad || r || ' on ' || t || '; '; END IF;
    END LOOP;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cloud_blob_erase_runs'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cloud_blob_erase_leases'::regclass) THEN bad := bad || 'RLS off; '; END IF;
  -- the role check inside: authenticated is refused by the grant, a caller with no service_role claim by the body
  t := pg_temp.call('authenticated', 'SELECT public.cloud_blob_erase_claim(true)::text');
  IF t NOT LIKE 'ERR 42501%' THEN bad := bad || 'authenticated claim: ' || t || '; '; END IF;
  t := pg_temp.call('', 'SELECT public.cloud_blob_erase_claim(true)::text');
  IF t NOT LIKE 'ERR 42501%service_role only%' THEN bad := bad || 'no-claim claim: ' || t || '; '; END IF;
  t := pg_temp.call('', 'SELECT public.cloud_blob_erase_scrub(gen_random_uuid(), gen_random_uuid(), true, 10)::text');
  IF t NOT LIKE 'ERR 42501%service_role only%' THEN bad := bad || 'no-claim scrub: ' || t || '; '; END IF;
  RETURN CASE WHEN bad = '' THEN 'PASS' ELSE 'FAIL ' || bad END;
END $p$;

-- P3 condition 3: no URL seed; invoke refuses while the URL secret is absent
CREATE FUNCTION pg_temp.p_invoke_url() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE t text; n bigint;
BEGIN
  DELETE FROM vault.secrets WHERE name = 'cloud_blob_erase_url';
  BEGIN
    PERFORM public.cloud_blob_erase_invoke();
    RETURN 'FAIL invoke ran with no URL secret';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '55000' OR SQLERRM NOT LIKE '%cloud_blob_erase_url%' THEN
      RETURN 'FAIL invoke without URL: ' || SQLSTATE || ' ' || SQLERRM;
    END IF;
  END;
  -- the empty string counts as absent
  PERFORM vault.create_secret('', 'cloud_blob_erase_url', 'harness');
  BEGIN
    PERFORM public.cloud_blob_erase_invoke();
    RETURN 'FAIL invoke ran with an empty URL secret';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '55000' THEN RETURN 'FAIL invoke with empty URL: ' || SQLSTATE || ' ' || SQLERRM; END IF;
  END;
  -- positive control: with a URL present it queues one request (this transaction is rolled back, so it is never sent)
  DELETE FROM vault.secrets WHERE name = 'cloud_blob_erase_url';
  PERFORM vault.create_secret('http://harness.invalid/cloud-blob-erase', 'cloud_blob_erase_url', 'harness');
  n := public.cloud_blob_erase_invoke();
  IF n IS NULL THEN RETURN 'FAIL invoke with a URL returned no request id'; END IF;
  RETURN 'PASS';
END $p$;

-- E1 seeds no URL, and a re-run keeps the existing secret
CREATE FUNCTION pg_temp.p_secrets(mig text) RETURNS text LANGUAGE plpgsql AS $p$
DECLARE before_id uuid; after_id uuid;
BEGIN
  DELETE FROM vault.secrets WHERE name = 'cloud_blob_erase_url';
  SELECT id INTO before_id FROM vault.secrets WHERE name = 'cloud_blob_erase_secret';
  IF before_id IS NULL THEN RETURN 'FAIL no cloud_blob_erase_secret after E1'; END IF;
  EXECUTE mig;
  SELECT id INTO after_id FROM vault.secrets WHERE name = 'cloud_blob_erase_secret';
  IF after_id IS DISTINCT FROM before_id THEN RETURN 'FAIL re-run replaced the secret'; END IF;
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cloud_blob_erase_url') THEN RETURN 'FAIL E1 created cloud_blob_erase_url'; END IF;
  RETURN 'PASS';
END $p$;

-- C-6a: bytes before rows. A claim that is never finished leaves the row; the next run lists it again; finish deletes
-- the row only once the object is gone. Also: finish of a dry run deletes nothing.
CREATE FUNCTION pg_temp.p_c6a() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE u uuid := pg_temp.mk_user(11); b uuid; c jsonb; f jsonb; dry jsonb;
BEGIN
  b := pg_temp.mk_blob(u, 'c6a', now() - interval '3 days', now() - interval '3 days', now() - interval '1 hour');
  PERFORM pg_temp.mk_obj(pg_temp.path(b), now() - interval '3 days');
  c := pg_temp.claim(false);
  IF NOT (b = ANY (pg_temp.ids(c))) THEN RETURN 'FAIL fenced blob not listed: ' || left(c::text, 300); END IF;
  -- the run "crashes" here: no remove, no finish. Its lease lapses.
  IF NOT EXISTS (SELECT 1 FROM public.cloud_blob_erase_leases WHERE blob_id = b) THEN RETURN 'FAIL no lease row'; END IF;
  c := pg_temp.claim(false);
  IF b = ANY (pg_temp.ids(c)) THEN RETURN 'FAIL listed again while leased'; END IF;
  UPDATE public.cloud_blob_erase_leases SET leased_until = now() - interval '1 second' WHERE blob_id = b;
  c := pg_temp.claim(false);
  IF NOT (b = ANY (pg_temp.ids(c))) THEN RETURN 'FAIL not listed again after the lease lapsed'; END IF;
  -- finish while the object still exists keeps the row
  f := pg_temp.finish((c ->> 'run_id')::uuid, ARRAY[b]);
  IF NOT EXISTS (SELECT 1 FROM public.cloud_blobs WHERE id = b) THEN RETURN 'FAIL row deleted while its object exists'; END IF;
  -- a dry run's finish deletes nothing even with the object gone
  PERFORM pg_temp.rm_obj(pg_temp.path(b));
  dry := pg_temp.claim(true);
  f := pg_temp.finish((dry ->> 'run_id')::uuid, ARRAY[b]);
  IF NOT EXISTS (SELECT 1 FROM public.cloud_blobs WHERE id = b) THEN RETURN 'FAIL a dry run finish deleted a row'; END IF;
  f := pg_temp.finish((c ->> 'run_id')::uuid, ARRAY[b]);
  IF EXISTS (SELECT 1 FROM public.cloud_blobs WHERE id = b) THEN RETURN 'FAIL row kept after its object is gone: ' || f::text; END IF;
  IF EXISTS (SELECT 1 FROM public.cloud_blob_erase_leases WHERE blob_id = b) THEN RETURN 'FAIL lease row kept'; END IF;
  RETURN 'PASS';
END $p$;

-- C-6b: a fenced blob that a file row still references is never listed and never deleted
CREATE FUNCTION pg_temp.p_c6b() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE u uuid := pg_temp.mk_user(12); d uuid; b uuid; c jsonb;
BEGIN
  d := pg_temp.mk_deal(u, pg_temp.fx(1201), 'c6b');
  b := pg_temp.mk_blob(u, 'c6b', now() - interval '3 days', now() - interval '3 days', NULL);
  PERFORM pg_temp.mk_file(u, d, 'c6b', NULL, b, NULL);
  UPDATE public.cloud_blobs SET purge_requested_at = now() - interval '2 hours' WHERE id = b;   -- fenced although referenced
  c := pg_temp.claim(false);
  IF b = ANY (pg_temp.ids(c)) THEN RETURN 'FAIL referenced fenced blob listed'; END IF;
  PERFORM pg_temp.finish((c ->> 'run_id')::uuid, ARRAY[b]);
  IF NOT EXISTS (SELECT 1 FROM public.cloud_blobs WHERE id = b) THEN RETURN 'FAIL referenced blob row deleted by finish'; END IF;
  IF (SELECT blob_id FROM public.cloud_deal_files WHERE local_attachment_id = 'c6b' AND cloud_deal_id = d) IS DISTINCT FROM b THEN
    RETURN 'FAIL file row lost its blob';
  END IF;
  RETURN 'PASS';
END $p$;

-- C-6c: the orphan sweep fences only unreferenced blobs older than 24 h (registration and upload)
CREATE FUNCTION pg_temp.p_c6c() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE u uuid := pg_temp.mk_user(13); d uuid; old_b uuid; young_b uuid; ref_b uuid; late_up uuid; never_up uuid; bad text := '';
        c jsonb; n_widened bigint;
BEGIN
  -- precondition for the listing assertions below: the claim lists at most 1000 blobs ordered by purge_requested_at,
  -- so a wrong listing of unfenced blobs is only visible while fewer than 900 blobs in the whole database are fenced
  -- or uploaded and unreferenced. Otherwise this control cannot tell, and says so instead of passing.
  SELECT count(*) INTO n_widened FROM public.cloud_blobs b
   WHERE (b.purge_requested_at IS NOT NULL OR b.uploaded_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_files f WHERE f.blob_id = b.id);
  IF n_widened >= 900 THEN RETURN 'PRECONDITION ' || n_widened || ' fenced or uploaded unreferenced blobs (need < 900)'; END IF;
  d := pg_temp.mk_deal(u, pg_temp.fx(1301), 'c6c');
  old_b    := pg_temp.mk_blob(u, 'c6c-old',   now() - interval '25 hours', now() - interval '25 hours', NULL);
  young_b  := pg_temp.mk_blob(u, 'c6c-young', now() - interval '23 hours', now() - interval '23 hours', NULL);
  ref_b    := pg_temp.mk_blob(u, 'c6c-ref',   now() - interval '3 days',   now() - interval '3 days',   NULL);
  late_up  := pg_temp.mk_blob(u, 'c6c-late',  now() - interval '3 days',   now() - interval '1 hour',   NULL);
  never_up := pg_temp.mk_blob(u, 'c6c-never', now() - interval '25 hours', NULL,                        NULL);
  PERFORM pg_temp.mk_file(u, d, 'c6c', NULL, ref_b, NULL);
  c := pg_temp.claim(false);
  IF young_b = ANY (pg_temp.ids(c)) THEN bad := bad || 'unfenced young blob listed for erasing; '; END IF;
  IF late_up = ANY (pg_temp.ids(c)) THEN bad := bad || 'unfenced recently uploaded blob listed for erasing; '; END IF;
  IF ref_b = ANY (pg_temp.ids(c)) THEN bad := bad || 'referenced blob listed for erasing; '; END IF;
  IF (SELECT purge_requested_at FROM public.cloud_blobs WHERE id = old_b) IS NULL THEN bad := bad || 'old orphan not fenced; '; END IF;
  IF (SELECT purge_requested_at FROM public.cloud_blobs WHERE id = never_up) IS NULL THEN bad := bad || 'never-uploaded orphan not fenced; '; END IF;
  IF (SELECT purge_requested_at FROM public.cloud_blobs WHERE id = young_b) IS NOT NULL THEN bad := bad || 'young blob fenced; '; END IF;
  IF (SELECT purge_requested_at FROM public.cloud_blobs WHERE id = ref_b) IS NOT NULL THEN bad := bad || 'referenced blob fenced; '; END IF;
  IF (SELECT purge_requested_at FROM public.cloud_blobs WHERE id = late_up) IS NOT NULL THEN bad := bad || 'recently uploaded blob fenced; '; END IF;
  RETURN CASE WHEN bad = '' THEN 'PASS' ELSE 'FAIL ' || bad END;
END $p$;

-- C-6d: rows removed more than 24 h ago are hard-deleted; 23 h and live rows are kept.
-- P3 condition 4: a live file row of a hard-deleted message is removed first and its blob fenced.
CREATE FUNCTION pg_temp.p_c6d() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE u uuid := pg_temp.mk_user(14); d uuid; m_old uuid; m_young uuid; m_live uuid; f_dep uuid; f_old uuid; f_young uuid;
        b uuid; bad text := '';
BEGIN
  d := pg_temp.mk_deal(u, pg_temp.fx(1401), 'c6d');
  m_old   := pg_temp.mk_msg(u, d, 'c6d-old',   now() - interval '25 hours');
  m_young := pg_temp.mk_msg(u, d, 'c6d-young', now() - interval '23 hours');
  m_live  := pg_temp.mk_msg(u, d, 'c6d-live',  NULL);
  b := pg_temp.mk_blob(u, 'c6d', now() - interval '2 days', now() - interval '2 days', NULL);
  f_dep   := pg_temp.mk_file(u, d, 'c6d-dep',   m_old, b, NULL);                      -- live file of a removed message
  f_old   := pg_temp.mk_file(u, d, 'c6d-fold',  m_live, NULL, now() - interval '25 hours');
  f_young := pg_temp.mk_file(u, d, 'c6d-fyoung', m_live, NULL, now() - interval '23 hours');
  PERFORM pg_temp.claim(false);
  IF EXISTS (SELECT 1 FROM public.cloud_deal_messages WHERE id = m_old) THEN bad := bad || '25 h message kept; '; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cloud_deal_messages WHERE id = m_young) THEN bad := bad || '23 h message deleted; '; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cloud_deal_messages WHERE id = m_live) THEN bad := bad || 'live message deleted; '; END IF;
  IF EXISTS (SELECT 1 FROM public.cloud_deal_files WHERE id = f_old) THEN bad := bad || '25 h file kept; '; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cloud_deal_files WHERE id = f_young) THEN bad := bad || '23 h file deleted; '; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cloud_deal_files WHERE id = f_dep AND removed_at IS NOT NULL AND filename IS NULL AND blob_id IS NULL) THEN
    bad := bad || 'file of the deleted message not removed and scrubbed; ';
  END IF;
  IF (SELECT purge_requested_at FROM public.cloud_blobs WHERE id = b) IS NULL THEN bad := bad || 'its blob not fenced; '; END IF;
  RETURN CASE WHEN bad = '' THEN 'PASS' ELSE 'FAIL ' || bad END;
END $p$;

-- C-6e (P3 condition 2): an object whose cloud_blobs row cascaded away with its user is listed for erasing once older
-- than 24 h; a younger one, and an object that still has its row, are not
CREATE FUNCTION pg_temp.p_c6e() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE u uuid := pg_temp.mk_user(15); k uuid := pg_temp.mk_user(16); b_old uuid; b_young uuid; b_kept uuid;
        n_old text; n_young text; n_kept text; c jsonb; bad text := '';
BEGIN
  b_old   := pg_temp.mk_blob(u, 'c6e-old',   now() - interval '3 days', now() - interval '3 days', NULL);
  b_young := pg_temp.mk_blob(u, 'c6e-young', now() - interval '2 hours', now() - interval '2 hours', NULL);
  b_kept  := pg_temp.mk_blob(k, 'c6e-kept',  now() - interval '3 days', now() - interval '3 days', now() - interval '1 hour');
  n_old := pg_temp.path(b_old); n_young := pg_temp.path(b_young); n_kept := pg_temp.path(b_kept);
  PERFORM pg_temp.mk_obj(n_old, now() - interval '3 days');
  PERFORM pg_temp.mk_obj(n_young, now() - interval '2 hours');
  PERFORM pg_temp.mk_obj(n_kept, now() - interval '3 days');
  DELETE FROM auth.users WHERE id = u;                                                     -- rows cascade (M1)
  IF EXISTS (SELECT 1 FROM public.cloud_blobs WHERE id IN (b_old, b_young)) THEN RETURN 'FAIL setup: blob rows did not cascade'; END IF;
  IF NOT pg_temp.obj_exists(n_old) THEN RETURN 'FAIL setup: object went with the user'; END IF;
  c := pg_temp.claim(false);
  IF NOT pg_temp.has_text(c, 'rowless', n_old) THEN bad := bad || 'rowless 3-day object not listed; '; END IF;
  IF pg_temp.has_text(c, 'rowless', n_young) THEN bad := bad || 'rowless 2-hour object listed; '; END IF;
  IF pg_temp.has_text(c, 'rowless', n_kept) THEN bad := bad || 'object with a row listed as rowless; '; END IF;
  RETURN CASE WHEN bad = '' THEN 'PASS' ELSE 'FAIL ' || bad END;
END $p$;

-- C-6f (P3 condition 6): one batch scrubs at most p_limit rows of the owner's non-active computers, files first, and
-- fences their blobs; the active computer's rows, and a blob it shares, are untouched; the run row counts the rows.
CREATE FUNCTION pg_temp.p_c6f() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE u uuid := pg_temp.mk_user(17); ia uuid := pg_temp.fx(1701); io uuid := pg_temp.fx(1702);
        da uuid; dob uuid; ma uuid; shared uuid; own uuid; fa uuid; c jsonb; r jsonb; run uuid; i int; bad text := '';
BEGIN
  PERFORM pg_temp.switch(true);
  PERFORM pg_temp.mk_settings(u, ia, now() - interval '1 hour');
  da := pg_temp.mk_deal(u, ia, 'c6f-active'); dob := pg_temp.mk_deal(u, io, 'c6f-old');
  ma := pg_temp.mk_msg(u, da, 'c6f-am', NULL);
  shared := pg_temp.mk_blob(u, 'c6f-shared', now() - interval '1 hour', now() - interval '1 hour', NULL);
  own    := pg_temp.mk_blob(u, 'c6f-own',    now() - interval '1 hour', now() - interval '1 hour', NULL);
  fa := pg_temp.mk_file(u, da, 'c6f-af', ma, shared, NULL);
  PERFORM pg_temp.mk_file(u, dob, 'c6f-of1', NULL, shared, NULL);
  PERFORM pg_temp.mk_file(u, dob, 'c6f-of2', NULL, own, NULL);
  FOR i IN 1..5 LOOP PERFORM pg_temp.mk_msg(u, dob, 'c6f-om' || i, NULL); END LOOP;      -- 2 files + 5 messages = 7
  c := pg_temp.claim(false); run := (c ->> 'run_id')::uuid;
  IF NOT pg_temp.has_text(c, 'scrub_owners', u::text) THEN bad := bad || 'owner not in scrub_owners; '; END IF;
  r := pg_temp.scrub(run, u, false, 5);
  IF (r ->> 'scrubbed')::int <> 5 OR (r ->> 'files')::int <> 2 OR (r ->> 'more')::boolean IS NOT TRUE THEN bad := bad || 'batch 1 ' || r::text || '; '; END IF;
  r := pg_temp.scrub(run, u, false, 5);
  IF (r ->> 'scrubbed')::int <> 2 OR (r ->> 'more')::boolean IS NOT FALSE THEN bad := bad || 'batch 2 ' || r::text || '; '; END IF;
  IF EXISTS (SELECT 1 FROM public.cloud_deal_messages WHERE cloud_deal_id = dob AND (removed_at IS NULL OR subject IS NOT NULL OR body_text IS NOT NULL OR participants IS NOT NULL)) THEN
    bad := bad || 'old computer message not scrubbed; ';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cloud_deal_files WHERE cloud_deal_id = dob AND (removed_at IS NULL OR filename IS NOT NULL OR blob_id IS NOT NULL)) THEN
    bad := bad || 'old computer file not scrubbed; ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cloud_deal_messages WHERE id = ma AND removed_at IS NULL AND body_text IS NOT NULL) THEN bad := bad || 'active message touched; '; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cloud_deal_files WHERE id = fa AND removed_at IS NULL AND blob_id = shared) THEN bad := bad || 'active file touched; '; END IF;
  IF (SELECT purge_requested_at FROM public.cloud_blobs WHERE id = own) IS NULL THEN bad := bad || 'old computer blob not fenced; '; END IF;
  IF (SELECT purge_requested_at FROM public.cloud_blobs WHERE id = shared) IS NOT NULL THEN bad := bad || 'shared blob fenced; '; END IF;
  IF (SELECT (counts ->> 'rows_scrubbed')::int FROM public.cloud_blob_erase_runs WHERE id = run) IS DISTINCT FROM 7 THEN bad := bad || 'run rows_scrubbed wrong; '; END IF;
  IF pg_temp.call('service_role', format('SELECT public.cloud_blob_erase_scrub(%L::uuid, %L::uuid, false, 1001)::text', run, u)) NOT LIKE 'ERR 22023%' THEN
    bad := bad || 'limit 1001 accepted; ';
  END IF;
  -- the next run's erase step picks up the fenced blob
  c := pg_temp.claim(false);
  IF NOT (own = ANY (pg_temp.ids(c))) THEN bad := bad || 'scrubbed blob not listed by the next claim; '; END IF;
  RETURN CASE WHEN bad = '' THEN 'PASS' ELSE 'FAIL ' || bad END;
END $p$;

-- note (after the scrub): adds only keys the run row does not hold; moves ok to partial, never a failed run back
CREATE FUNCTION pg_temp.p_note() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE c jsonb; run uuid; run2 uuid; r record; t text;
BEGIN
  c := pg_temp.claim(false); run := (c ->> 'run_id')::uuid;
  PERFORM pg_temp.finish(run, '{}');
  SELECT * INTO r FROM public.cloud_blob_erase_runs WHERE id = run;
  IF r.outcome <> 'ok' OR NOT (r.counts ? 'blob_rows_deleted') THEN RETURN 'FAIL setup: ' || r.outcome || ' ' || r.counts::text; END IF;
  PERFORM pg_temp.svc(format('SELECT public.cloud_blob_erase_note(%L::uuid, %L::jsonb, %L)::text', run,
                             '{"blob_rows_deleted": 99, "scrub_errors": 2, "scrub_owners_left": 3, "Bad-Key": 1, "scrub_text": "x"}', 'partial'));
  SELECT * INTO r FROM public.cloud_blob_erase_runs WHERE id = run;
  IF (r.counts ->> 'blob_rows_deleted')::int <> 0 THEN RETURN 'FAIL note overwrote blob_rows_deleted: ' || r.counts::text; END IF;
  IF (r.counts ->> 'scrub_errors')::int IS DISTINCT FROM 2 OR (r.counts ->> 'scrub_owners_left')::int IS DISTINCT FROM 3 THEN RETURN 'FAIL scrub counts not added'; END IF;
  IF r.counts ? 'Bad-Key' OR r.counts ? 'scrub_text' THEN RETURN 'FAIL note kept a non-count key'; END IF;
  IF r.outcome <> 'partial' THEN RETURN 'FAIL outcome not moved to partial: ' || r.outcome; END IF;
  c := pg_temp.claim(false); run2 := (c ->> 'run_id')::uuid;
  PERFORM pg_temp.svc(format('SELECT public.cloud_blob_erase_finish(%L::uuid, %L::uuid[], %L::jsonb, %L)::text', run2, '{}', '{}', 'failed'));
  PERFORM pg_temp.svc(format('SELECT public.cloud_blob_erase_note(%L::uuid, %L::jsonb, %L)::text', run2, '{}', 'partial'));
  IF (SELECT outcome FROM public.cloud_blob_erase_runs WHERE id = run2) <> 'failed' THEN RETURN 'FAIL note changed a failed run'; END IF;
  t := pg_temp.call('', format('SELECT public.cloud_blob_erase_note(%L::uuid, %L::jsonb, %L)::text', run, '{}', 'ok'));
  IF t NOT LIKE 'ERR 42501%service_role only%' THEN RETURN 'FAIL no-claim note: ' || t; END IF;
  RETURN 'PASS';
END $p$;

-- the scrub does nothing while one_computer is off or no computer is active
CREATE FUNCTION pg_temp.p_scrub_off() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE u uuid := pg_temp.mk_user(18); v uuid := pg_temp.mk_user(19); d uuid; m uuid; m2 uuid; run uuid; r jsonb; c jsonb; bad text := '';
BEGIN
  PERFORM pg_temp.mk_settings(u, pg_temp.fx(1801), now());
  PERFORM pg_temp.mk_settings(v, NULL, NULL);
  d := pg_temp.mk_deal(u, pg_temp.fx(1802), 'off'); m := pg_temp.mk_msg(u, d, 'off', NULL);
  m2 := pg_temp.mk_msg(v, pg_temp.mk_deal(v, pg_temp.fx(1901), 'noactive'), 'noactive', NULL);
  PERFORM pg_temp.switch(false);
  c := pg_temp.claim(false); run := (c ->> 'run_id')::uuid;
  IF pg_temp.has_text(c, 'scrub_owners', u::text) THEN bad := bad || 'owner listed with the switch off; '; END IF;
  r := pg_temp.scrub(run, u, false, 1000);
  IF r ->> 'state' <> 'not_applicable' THEN bad := bad || 'switch off: ' || r::text || '; '; END IF;
  PERFORM pg_temp.switch(true);
  r := pg_temp.scrub(run, v, false, 1000);
  IF r ->> 'state' <> 'not_applicable' THEN bad := bad || 'no active computer: ' || r::text || '; '; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cloud_deal_messages WHERE id IN (m, m2) AND removed_at IS NULL GROUP BY true HAVING count(*) = 2) THEN
    bad := bad || 'rows scrubbed; ';
  END IF;
  r := pg_temp.scrub(run, pg_temp.fx(1999), false, 1000);
  IF r ->> 'state' <> 'none' THEN bad := bad || 'unknown owner: ' || r::text || '; '; END IF;
  RETURN CASE WHEN bad = '' THEN 'PASS' ELSE 'FAIL ' || bad END;
END $p$;

-- owners list: oldest move first; an owner with only active-computer rows is not listed
CREATE FUNCTION pg_temp.p_owners() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE a uuid := pg_temp.mk_user(21); b uuid := pg_temp.mk_user(22); c uuid := pg_temp.mk_user(23); j jsonb; pa int; pb int;
BEGIN
  PERFORM pg_temp.switch(true);
  PERFORM pg_temp.mk_settings(a, pg_temp.fx(2101), '2000-01-02'::timestamptz);
  PERFORM pg_temp.mk_settings(b, pg_temp.fx(2201), '2000-01-01'::timestamptz);
  PERFORM pg_temp.mk_settings(c, pg_temp.fx(2301), '2000-01-01'::timestamptz);
  PERFORM pg_temp.mk_msg(a, pg_temp.mk_deal(a, pg_temp.fx(2102), 'own-a'), 'own-a', NULL);
  PERFORM pg_temp.mk_msg(b, pg_temp.mk_deal(b, pg_temp.fx(2202), 'own-b'), 'own-b', NULL);
  PERFORM pg_temp.mk_msg(c, pg_temp.mk_deal(c, pg_temp.fx(2301), 'own-c'), 'own-c', NULL);   -- active computer only
  j := pg_temp.claim(true) -> 'scrub_owners';
  SELECT o.n INTO pa FROM jsonb_array_elements_text(j) WITH ORDINALITY o(v, n) WHERE o.v = a::text;
  SELECT o.n INTO pb FROM jsonb_array_elements_text(j) WITH ORDINALITY o(v, n) WHERE o.v = b::text;
  IF pa IS NULL OR pb IS NULL THEN RETURN 'FAIL owner missing: ' || left(j::text, 300); END IF;
  IF pb > pa THEN RETURN 'FAIL older move listed later'; END IF;
  IF pg_temp.has_text(jsonb_build_object('x', j), 'x', c::text) THEN RETURN 'FAIL owner with only active rows listed'; END IF;
  RETURN 'PASS';
END $p$;

-- C-6g single-session sequence (the two-session C-6g is concurrency/c6g-*.sh): after a move back to the old computer,
-- the next batch scrubs none of that computer's rows (re-sent or not yet scrubbed), and scrubs the other computer's.
CREATE FUNCTION pg_temp.p_c6g_seq() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE u uuid := pg_temp.mk_user(24); i1 uuid := pg_temp.fx(2401); i2 uuid := pg_temp.fx(2402); d1 uuid; d2 uuid;
        m2a uuid; m2b uuid; m1 uuid; run uuid; r jsonb; bad text := '';
BEGIN
  PERFORM pg_temp.switch(true);
  PERFORM pg_temp.mk_settings(u, i1, now());
  d1 := pg_temp.mk_deal(u, i1, 'g1'); d2 := pg_temp.mk_deal(u, i2, 'g2');
  m1 := pg_temp.mk_msg(u, d1, 'g1', NULL);
  m2a := pg_temp.mk_msg(u, d2, 'g2a', NULL); m2b := pg_temp.mk_msg(u, d2, 'g2b', NULL);
  run := (pg_temp.claim(false) ->> 'run_id')::uuid;
  r := pg_temp.scrub(run, u, false, 1);                                                    -- scrubs m2a only
  IF NOT EXISTS (SELECT 1 FROM public.cloud_deal_messages WHERE id = m2a AND removed_at IS NOT NULL) THEN RETURN 'FAIL setup: m2a not scrubbed'; END IF;
  -- the move back (what cloud_claim_install(p_replace = true) writes) and the re-send of m2a (the upsert clears removed_at)
  UPDATE public.cloud_autosave_settings SET active_install_id = i2, active_since = now() WHERE user_id = u;
  UPDATE public.cloud_deal_messages SET removed_at = NULL, subject = 'resent', body_text = 'resent', version = version + 1 WHERE id = m2a;
  r := pg_temp.scrub(run, u, false, 1000);
  IF NOT EXISTS (SELECT 1 FROM public.cloud_deal_messages WHERE id = m2a AND removed_at IS NULL AND body_text = 'resent') THEN bad := bad || 're-sent row scrubbed; '; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cloud_deal_messages WHERE id = m2b AND removed_at IS NULL) THEN bad := bad || 'unscrubbed row of the now-active computer scrubbed; '; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cloud_deal_messages WHERE id = m1 AND removed_at IS NOT NULL) THEN bad := bad || 'now-inactive computer row not scrubbed; '; END IF;
  RETURN CASE WHEN bad = '' THEN 'PASS' ELSE 'FAIL ' || bad END;
END $p$;

-- dry run: claim and scrub change no cloud row, fence nothing, lease nothing, delete no object; only run rows are added
CREATE FUNCTION pg_temp.p_dry_run() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE u uuid := pg_temp.mk_user(25); k uuid := pg_temp.mk_user(26); ia uuid := pg_temp.fx(2501); d uuid; dob uuid; m uuid;
        b_orphan uuid; b_fenced uuid; b_live uuid; b_old uuid; before text; after text; c jsonb; r jsonb; runs_before bigint;
BEGIN
  PERFORM pg_temp.switch(true);
  PERFORM pg_temp.mk_settings(u, ia, now() - interval '2 hours');
  d := pg_temp.mk_deal(u, ia, 'dry'); dob := pg_temp.mk_deal(u, pg_temp.fx(2502), 'dry-old');
  m := pg_temp.mk_msg(u, d, 'dry-removed', now() - interval '3 days');                     -- hard-delete arm
  b_live := pg_temp.mk_blob(u, 'dry-live', now() - interval '3 days', now() - interval '3 days', NULL);
  PERFORM pg_temp.mk_file(u, d, 'dry-dep', m, b_live, NULL);                               -- tombstone-with-message arm
  PERFORM pg_temp.mk_file(u, d, 'dry-fremoved', NULL, NULL, now() - interval '3 days');
  b_orphan := pg_temp.mk_blob(u, 'dry-orphan', now() - interval '3 days', now() - interval '3 days', NULL);   -- orphan arm
  b_fenced := pg_temp.mk_blob(u, 'dry-fenced', now() - interval '3 days', now() - interval '3 days', now() - interval '1 hour');
  PERFORM pg_temp.mk_obj(pg_temp.path(b_fenced), now() - interval '3 days');               -- erase arm
  PERFORM pg_temp.mk_obj(k::text || '/' || gen_random_uuid()::text, now() - interval '3 days');   -- rowless arm
  PERFORM pg_temp.mk_msg(u, dob, 'dry-old-m', NULL);                                       -- scrub arm
  b_old := pg_temp.mk_blob(u, 'dry-old', now() - interval '1 hour', now() - interval '1 hour', NULL);
  PERFORM pg_temp.mk_file(u, dob, 'dry-old-f', NULL, b_old, NULL);
  before := (SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
      SELECT 'm' || id || coalesce(removed_at::text, '-') || coalesce(subject, '-') || version FROM public.cloud_deal_messages WHERE owner_user_id = u
      UNION ALL SELECT 'f' || id || coalesce(removed_at::text, '-') || coalesce(filename, '-') || coalesce(blob_id::text, '-') || version FROM public.cloud_deal_files WHERE owner_user_id = u
      UNION ALL SELECT 'b' || id || coalesce(purge_requested_at::text, '-') FROM public.cloud_blobs WHERE owner_user_id IN (u, k)
      UNION ALL SELECT 'o' || name FROM storage.objects WHERE bucket_id = 'cloud-deal-files' AND (name LIKE u::text || '/%' OR name LIKE k::text || '/%')
      UNION ALL SELECT 'l' || blob_id FROM public.cloud_blob_erase_leases WHERE blob_id IN (b_orphan, b_fenced, b_live)) s(x));
  SELECT count(*) INTO runs_before FROM public.cloud_blob_erase_runs;
  c := pg_temp.claim(true);
  IF (c -> 'counts' ->> 'messages_hard_deleted')::int < 1 OR (c -> 'counts' ->> 'blobs_listed')::int < 1 THEN
    RETURN 'FAIL setup: the dry claim saw nothing to do: ' || left(c::text, 300);
  END IF;
  IF jsonb_array_length(c -> 'blobs') <> 0 OR jsonb_array_length(c -> 'rowless') <> 0 THEN RETURN 'FAIL a dry claim returned paths'; END IF;
  r := pg_temp.scrub((c ->> 'run_id')::uuid, u, true, 1000);
  IF (r ->> 'would_scrub')::int < 2 THEN RETURN 'FAIL setup: the dry scrub saw nothing: ' || r::text; END IF;
  after := (SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
      SELECT 'm' || id || coalesce(removed_at::text, '-') || coalesce(subject, '-') || version FROM public.cloud_deal_messages WHERE owner_user_id = u
      UNION ALL SELECT 'f' || id || coalesce(removed_at::text, '-') || coalesce(filename, '-') || coalesce(blob_id::text, '-') || version FROM public.cloud_deal_files WHERE owner_user_id = u
      UNION ALL SELECT 'b' || id || coalesce(purge_requested_at::text, '-') FROM public.cloud_blobs WHERE owner_user_id IN (u, k)
      UNION ALL SELECT 'o' || name FROM storage.objects WHERE bucket_id = 'cloud-deal-files' AND (name LIKE u::text || '/%' OR name LIKE k::text || '/%')
      UNION ALL SELECT 'l' || blob_id FROM public.cloud_blob_erase_leases WHERE blob_id IN (b_orphan, b_fenced, b_live)) s(x));
  IF before IS DISTINCT FROM after THEN RETURN 'FAIL a dry run changed rows'; END IF;
  IF (SELECT count(*) FROM public.cloud_blob_erase_runs) <> runs_before + 1 THEN RETURN 'FAIL run rows: want one added'; END IF;
  RETURN 'PASS';
END $p$;

-- E3: refuses without the URL secret; with it, schedules minute 23 calling invoke
CREATE FUNCTION pg_temp.p_e3(sched text) RETURNS text LANGUAGE plpgsql AS $p$
DECLARE j record;
BEGIN
  DELETE FROM vault.secrets WHERE name = 'cloud_blob_erase_url';
  BEGIN
    EXECUTE sched;
    RETURN 'FAIL E3 applied with no URL secret';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%cloud_blob_erase_url%' THEN RETURN 'FAIL E3 without URL: ' || SQLERRM; END IF;
  END;
  PERFORM vault.create_secret('http://harness.invalid/cloud-blob-erase', 'cloud_blob_erase_url', 'harness');
  EXECUTE sched;
  SELECT schedule, command, active INTO j FROM cron.job WHERE jobname = 'cloud-blob-erase';
  IF j.schedule IS DISTINCT FROM '23 * * * *' OR j.command IS DISTINCT FROM 'SELECT public.cloud_blob_erase_invoke()' OR j.active IS NOT TRUE THEN
    RETURN 'FAIL job: ' || coalesce(j.schedule, '(none)') || ' / ' || coalesce(j.command, '');
  END IF;
  RETURN 'PASS';
END $p$;

-- rollback files remove every object E1 and E3 created
CREATE FUNCTION pg_temp.p_rollback(rb3 text, rb1 text) RETURNS text LANGUAGE plpgsql AS $p$
BEGIN
  EXECUTE rb3;
  EXECUTE rb1;
  IF to_regprocedure('public.cloud_blob_erase_claim(boolean,integer,integer)') IS NOT NULL
     OR to_regprocedure('public.cloud_blob_erase_invoke()') IS NOT NULL
     OR to_regclass('public.cloud_blob_erase_runs') IS NOT NULL
     OR EXISTS (SELECT 1 FROM vault.secrets WHERE name IN ('cloud_blob_erase_secret', 'cloud_blob_erase_url'))
     OR EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cloud-blob-erase') THEN
    RETURN 'FAIL objects left after rollback';
  END IF;
  RETURN 'PASS';
END $p$;
