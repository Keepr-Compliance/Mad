-- harness: apply-twice
-- C10: applying the file twice raises nothing and leaves the same catalogue.
DO $$ DECLARE m text; BEGIN
  PERFORM pg_temp.check('c10 second apply leaves the catalogue unchanged',
    pg_temp.fp3917_md5() = current_setting('t3917.fp_once'), pg_temp.fp3917_md5() || ' vs ' || current_setting('t3917.fp_once'));
  m := pg_temp.as_user('u_s', $q$update public.organization_members set role='admin' where id='{m_g}'$q$);
  PERFORM pg_temp.check('c10 suspended admin still refused', pg_temp.refused(m), m);
  m := pg_temp.as_user('u_a', $q$update public.organization_members set role='broker' where id='{m_g}'$q$);
  PERFORM pg_temp.check('c10 active admin still allowed', m = 'OK rows=1', m);
END $$;
