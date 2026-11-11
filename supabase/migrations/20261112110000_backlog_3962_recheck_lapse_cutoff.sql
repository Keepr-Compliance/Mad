-- BACKLOG-3962 PR2: lapsed claims leave the daily re-check 30 days after their last counted miss.
--
-- Replaces ONE function body, same signature, same grants:
--   _domain_claims_due_for_recheck(integer)  server role only (checked inside)
-- Change: a lapsed claim whose last_miss_counted_at is 30 days old or older is no longer due.
-- Verified claims, and the manual Check (_domain_claim_begin_check / _domain_claim_record_check
-- with p_source 'manual'), are unchanged.
--
-- Rollback: supabase/tests/backlog-3962/rollback-3962-pr2.sql (restores the PR1 body).
-- Harness: supabase/tests/backlog-3962/ (compose.py pr2 modes, controls-pr2.sql).

-- Pre-check: the body replaced here is the PR1 body (20261112100000), read on keepr-test 2026-11-10.
DO $guard$
DECLARE v text;
BEGIN
  SELECT md5(prosrc) INTO v FROM pg_proc
   WHERE oid = 'public._domain_claims_due_for_recheck(integer)'::regprocedure;
  IF v IS DISTINCT FROM 'dc93015cbbcc7f6a77bcd8325f3a02d9' THEN
    RAISE EXCEPTION 'BACKLOG-3962: _domain_claims_due_for_recheck md5 % is not the PR1 body', v;
  END IF;
END
$guard$;

-- Verified and lapsed claims not checked for 20 h; lapsed ones only for 30 days after the last
-- counted miss. Selects and stamps in one statement (FOR UPDATE SKIP LOCKED).
CREATE OR REPLACE FUNCTION public._domain_claims_due_for_recheck(p_limit integer)
RETURNS TABLE (claim_id uuid, organization_id uuid, domain text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT c.id FROM public.domain_claims c
     WHERE c.status IN ('verified', 'lapsed')
       AND (c.last_checked_at IS NULL OR c.last_checked_at < now() - interval '20 hours')
       -- S3: a lapsed claim leaves the daily re-check 30 days after its last counted miss.
       -- Every lapse is written with last_miss_counted_at = now() (record_check), so a lapsed
       -- row with a NULL value is not produced by these functions.
       AND NOT (c.status = 'lapsed' AND c.last_miss_counted_at <= now() - interval '30 days')
     ORDER BY c.last_checked_at NULLS FIRST
     LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.domain_claims d
     SET last_checked_at = now(), updated_at = now()
    FROM due
   WHERE d.id = due.id
  RETURNING d.id, d.organization_id, d.domain;
END;
$function$;

-- Grants: unchanged by CREATE OR REPLACE; restated so the file stands on its own.
REVOKE ALL ON FUNCTION public._domain_claims_due_for_recheck(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._domain_claims_due_for_recheck(integer) TO service_role;

-- Post-check: the PR1 block, unchanged.
-- POSTCHECK BEGIN
DO $guard$
DECLARE
  f text;
  v_client_ok text[] := ARRAY[
    'public.domain_claim_create(uuid, text)',
    'public.domain_claim_withdraw(uuid)',
    'public.admin_list_domain_claims(uuid)',
    'public.admin_revoke_domain_claim(uuid, text)'];
  v_closed text[] := ARRAY[
    'public._normalize_claim_domain(text)',
    'public._is_consumer_email_domain(text)',
    'public._domain_claim_begin_check(uuid, uuid)',
    'public._domain_claim_record_check(uuid, uuid, text[], boolean, text)',
    'public._domain_claims_due_for_recheck(integer)'];
  v_definer text[] := ARRAY[
    'public.domain_claim_create(uuid, text)',
    'public.domain_claim_withdraw(uuid)',
    'public.admin_list_domain_claims(uuid)',
    'public.admin_revoke_domain_claim(uuid, text)',
    'public._domain_claim_begin_check(uuid, uuid)',
    'public._domain_claim_record_check(uuid, uuid, text[], boolean, text)',
    'public._domain_claims_due_for_recheck(integer)'];
BEGIN
  FOREACH f IN ARRAY v_client_ok || v_closed LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'BACKLOG-3962: anon can execute %', f;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f::regprocedure
                     AND p.proconfig @> ARRAY['search_path=""']) THEN
      RAISE EXCEPTION 'BACKLOG-3962: % does not pin an empty search_path', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY v_closed LOOP
    IF has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'BACKLOG-3962: authenticated can execute %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY v_client_ok LOOP
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'BACKLOG-3962: authenticated cannot execute %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY v_definer LOOP
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f::regprocedure) THEN
      RAISE EXCEPTION 'BACKLOG-3962: % is not SECURITY DEFINER', f;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.domain_claims', 'SELECT')
     OR has_table_privilege('anon', 'public.domain_claims', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.domain_claims', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.domain_claims', 'INSERT')
     OR has_table_privilege('authenticated', 'public.domain_claims', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.domain_claims', 'DELETE') THEN
    RAISE EXCEPTION 'BACKLOG-3962: a client role has a write or truncate grant on domain_claims';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.domain_claims'::regclass) THEN
    RAISE EXCEPTION 'BACKLOG-3962: row level security is off on domain_claims';
  END IF;
  IF (SELECT count(*) FROM pg_policy p WHERE p.polrelid = 'public.domain_claims'::regclass) <> 1 THEN
    RAISE EXCEPTION 'BACKLOG-3962: domain_claims must carry exactly one policy';
  END IF;
END
$guard$;
-- POSTCHECK END
