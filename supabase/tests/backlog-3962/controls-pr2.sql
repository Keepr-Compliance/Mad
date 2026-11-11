-- BACKLOG-3962 PR2 (20261112110000) controls: the 30-day lapse cutoff in
-- _domain_claims_due_for_recheck, and the cron's call order (due -> record_check 'recheck').
-- Venue: keepr-test via ~/.claude/bin/kt-sql. compose.py prepends rollback-3962-pr2.sql (the PR1
-- body) and the PR2 migration (or a mutant of it). ONE implicit transaction ending in RAISE.
-- now() is fixed inside one transaction; elapsed time is simulated by moving timestamps back.
-- Output: RAISE 'P3962_RESULT {"mode":..., "pass":n, "fail":n, "reds":{...}, "obs":{...}}'.

CREATE FUNCTION pg_temp.id(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$ SELECT md5('bl3962p2:' || t)::uuid $b$;
CREATE FUNCTION pg_temp.tk(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT 'keepr-domain-verification=' || left(md5('a' || t) || md5('b' || t), 48) $b$;

CREATE FUNCTION pg_temp.q(r text, q text) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE v text;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('role', r)::text, true);
    PERFORM set_config('request.jwt.claim.role', r, true);
    EXECUTE format('SET LOCAL ROLE %I', r);
    EXECUTE q INTO v;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
    RETURN coalesce(v, 'null');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
  END;
END $b$;

-- The cron's first call. Returns 'claim_id:organization_id' pairs, comma-separated.
CREATE FUNCTION pg_temp.due() RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.q('service_role',
    'SELECT coalesce(string_agg(claim_id::text || '':'' || organization_id::text, '',''), '''') FROM public._domain_claims_due_for_recheck(50)')
$b$;
CREATE FUNCTION pg_temp.rc(c uuid, o uuid, answers text[], src text) RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.q('service_role', format(
    'SELECT public._domain_claim_record_check(%L::uuid, %L::uuid, %L::text[], true, %L)::text', c, o, answers, src))
$b$;
CREATE FUNCTION pg_temp.bc(c uuid, o uuid) RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.q('service_role', format('SELECT public._domain_claim_begin_check(%L::uuid, %L::uuid)::text', c, o))
$b$;

INSERT INTO public.organizations (id, name, slug, is_test, max_seats) VALUES
  (pg_temp.id('oA'), 'Org A 3962 p2', 'org-a-3962-p2', true, 10),
  (pg_temp.id('oB'), 'Org B 3962 p2', 'org-b-3962-p2', true, 10);

-- Fixture rows, in the shapes record_check writes (PR1 :384-:427):
--   V1   verified, never missed, checked 21 h ago                     -> due; a re-check miss counts
--   L29  lapsed (3 counted misses), last counted miss 29 d 23 h ago   -> due
--   L30  lapsed, last counted miss 30 d 1 h ago                       -> not due
--   V31  verified with 1 counted miss 31 d ago (a stale counter)      -> due (the cutoff is lapsed-only)
-- L29 / L30 move ONLY last_miss_counted_at: last_checked_at stays 21 h ago and verified_at 60 d ago,
-- so a cutoff keyed on either of those would not separate them.
INSERT INTO public.domain_claims (id, organization_id, domain, token, status, verified_at, last_checked_at,
                                  last_check_result, consecutive_misses, last_miss_counted_at) VALUES
  (pg_temp.id('V1'),  pg_temp.id('oA'), 'v1-3962p2.test',  pg_temp.tk('V1'),  'verified', now() - interval '60 days',
     now() - interval '21 hours', 'verified', 0, NULL),
  (pg_temp.id('L29'), pg_temp.id('oB'), 'l29-3962p2.test', pg_temp.tk('L29'), 'lapsed', now() - interval '60 days',
     now() - interval '21 hours', 'not_found', 3, now() - interval '29 days 23 hours'),
  (pg_temp.id('L30'), pg_temp.id('oA'), 'l30-3962p2.test', pg_temp.tk('L30'), 'lapsed', now() - interval '60 days',
     now() - interval '21 hours', 'not_found', 3, now() - interval '30 days 1 hour'),
  (pg_temp.id('V31'), pg_temp.id('oB'), 'v31-3962p2.test', pg_temp.tk('V31'), 'verified', now() - interval '60 days',
     now() - interval '21 hours', 'not_found', 1, now() - interval '31 days');

DO $drv$
DECLARE
  oA uuid := pg_temp.id('oA'); oB uuid := pg_temp.id('oB');
  V1 uuid := pg_temp.id('V1'); L29 uuid := pg_temp.id('L29'); L30 uuid := pg_temp.id('L30'); V31 uuid := pg_temp.id('V31');
  g text; d text; d2 text; n int;
  v_pass int := 0; v_fail int := 0; reds jsonb := '{}'::jsonb; obs jsonb := '{}'::jsonb; k record;
BEGIN
  CREATE TEMP TABLE r3962p2 (k text, ok boolean, got text) ON COMMIT DROP;

  d := pg_temp.due();
  INSERT INTO r3962p2 VALUES ('P01_verified_due_with_its_org', position((V1 || ':' || oA) IN d) > 0, d);
  INSERT INTO r3962p2 VALUES ('P02_lapsed_29d23h_due', position((L29 || ':' || oB) IN d) > 0, d);
  INSERT INTO r3962p2 VALUES ('P03_lapsed_30d1h_not_due', position(L30::text IN d) = 0, d);
  INSERT INTO r3962p2 VALUES ('P04_verified_31d_counted_miss_still_due', position((V31 || ':' || oB) IN d) > 0, d);
  SELECT last_checked_at INTO STRICT g FROM public.domain_claims WHERE id = L30;
  INSERT INTO r3962p2 VALUES ('P03b_not_due_row_not_stamped',
    (SELECT last_checked_at = now() - interval '21 hours' FROM public.domain_claims WHERE id = L30), g);

  -- The cron's second call, on the row due returned: a miss on a verified row counts.
  g := pg_temp.rc(V1, oA, ARRAY[]::text[], 'recheck');
  SELECT consecutive_misses INTO n FROM public.domain_claims WHERE id = V1;
  INSERT INTO r3962p2 VALUES ('P05_due_then_recheck_counts_a_miss',
    g LIKE '%"result": "not_found"%' AND n = 1
      AND (SELECT last_miss_counted_at = now() FROM public.domain_claims WHERE id = V1), g);
  -- The same miss as 'manual' does not count (why the cron must pass 'recheck').
  UPDATE public.domain_claims SET consecutive_misses = 0, last_miss_counted_at = NULL WHERE id = V1;
  g := pg_temp.rc(V1, oA, ARRAY[]::text[], 'manual');
  SELECT consecutive_misses INTO n FROM public.domain_claims WHERE id = V1;
  INSERT INTO r3962p2 VALUES ('P06_manual_miss_does_not_count', g LIKE '%"result": "not_found"%' AND n = 0, g);
  -- begin_check right after due refuses: due stamped last_checked_at (why the cron never calls it).
  g := pg_temp.bc(L29, oB);
  INSERT INTO r3962p2 VALUES ('P07_begin_check_after_due_too_soon', g LIKE '%too_soon%', g);

  -- A second due run in the same transaction returns none of them (all stamped, or cut off).
  d2 := pg_temp.due();
  INSERT INTO r3962p2 VALUES ('P08_second_run_takes_none',
    position(V1::text IN d2) = 0 AND position(L29::text IN d2) = 0 AND position(L30::text IN d2) = 0
      AND position(V31::text IN d2) = 0, d2);

  -- Manual Check on a lapsed claim past the cutoff still runs and records (miss, then hit).
  g := pg_temp.bc(L30, oA);
  INSERT INTO r3962p2 VALUES ('P09_manual_begin_on_old_lapsed_ok', g LIKE '%"success": true%', g);
  g := pg_temp.rc(L30, oA, ARRAY['v=spf1 -all'], 'manual');
  INSERT INTO r3962p2 VALUES ('P10_manual_miss_on_old_lapsed_recorded',
    g LIKE '%"result": "not_found"%'
      AND (SELECT last_checked_at = now() AND last_check_result = 'not_found' AND status = 'lapsed'
             FROM public.domain_claims WHERE id = L30), g);
  g := pg_temp.rc(L30, oA, ARRAY[pg_temp.tk('L30')], 'manual');
  INSERT INTO r3962p2 VALUES ('P11_manual_hit_on_old_lapsed_verifies',
    g LIKE '%"result": "verified"%' AND (SELECT status FROM public.domain_claims WHERE id = L30) = 'verified', g);

  -- Observation, not a pass/fail case: a lapsed row with a NULL last_miss_counted_at. No function
  -- writes this shape (every lapse stamps now()); the clause leaves it out of the due set.
  INSERT INTO public.domain_claims (id, organization_id, domain, token, status, last_checked_at, consecutive_misses)
    VALUES (pg_temp.id('LN'), oB, 'ln-3962p2.test', pg_temp.tk('LN'), 'lapsed', now() - interval '21 hours', 3);
  d := pg_temp.due();
  obs := obs || jsonb_build_object('lapsed_null_counted_is_due', position(pg_temp.id('LN')::text IN d) > 0);

  FOR k IN SELECT * FROM r3962p2 ORDER BY r3962p2.k LOOP
    IF k.ok THEN v_pass := v_pass + 1;
    ELSE v_fail := v_fail + 1; reds := reds || jsonb_build_object(k.k, coalesce(k.got, 'NULL'));
    END IF;
  END LOOP;
  RAISE EXCEPTION 'P3962_RESULT %', jsonb_build_object('mode', current_setting('p3962.mode', true),
    'pass', v_pass, 'fail', v_fail, 'reds', reds, 'obs', obs);
END
$drv$;
