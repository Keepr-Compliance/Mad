-- BACKLOG-3917 preconditions. Runs after the venue-parity layers and before the
-- 3917 file. Every policy, trigger and RLS flag on every table this harness
-- reads or writes, and every function the changed objects call, must equal
-- production's (t3917_prod). A failure raises; the run reads ERROR.
DO $pre$ DECLARE bad text; BEGIN
  SELECT string_agg(coalesce(f.k, p.k) || ' venue=' || coalesce(f.v, '<missing>') || ' prod=' || coalesce(p.v, '<missing>'), '; ')
    INTO bad
    FROM pg_temp.fp3917() f FULL JOIN t3917_prod p ON p.k = f.k
   WHERE f.v IS DISTINCT FROM p.v;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'precondition: venue differs from production: %', bad;
  END IF;
  IF to_regprocedure('public.member_status_grants_access(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition: member_status_grants_access already exists';
  END IF;
END $pre$;
SELECT set_config('t3917.fp_before', pg_temp.fp3917_md5(), true) IS NULL;
