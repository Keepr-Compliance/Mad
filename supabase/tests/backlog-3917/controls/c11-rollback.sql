-- harness: rollback
-- C11: rollback-3917.sql restores production: every pinned object's md5 equals
-- production's again, the helper is gone, and the pre-3917 behaviour returns.
DO $$ DECLARE m text; bad text; BEGIN
  SELECT string_agg(coalesce(f.k, p.k) || ' venue=' || coalesce(f.v, '<missing>') || ' prod=' || coalesce(p.v, '<missing>'), '; ')
    INTO bad FROM pg_temp.fp3917() f FULL JOIN t3917_prod p ON p.k = f.k WHERE f.v IS DISTINCT FROM p.v;
  PERFORM pg_temp.check('c11 every pinned object md5 equals production after rollback', bad IS NULL, bad);
  PERFORM pg_temp.check('c11 fingerprint equals fp_before',
    pg_temp.fp3917_md5() = current_setting('t3917.fp_before'), pg_temp.fp3917_md5() || ' vs ' || current_setting('t3917.fp_before'));
  PERFORM pg_temp.check('c11 helper removed', to_regprocedure('public.member_status_grants_access(text)') IS NULL);
  m := pg_temp.as_user('u_s', $q$update public.organizations set retention_years = 3 where id='{org1}'$q$);
  PERFORM pg_temp.check('c11 after rollback: suspended admin org write lands again (production behaviour)', m = 'OK rows=1', m);
END $$;
