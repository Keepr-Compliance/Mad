-- harness: rollback
-- After rollback-3679.sql the catalogue matches the pre-migration fingerprint
-- (taken by the harness before the migration ran) and production behaviour is back.
DO $$ DECLARE m text; BEGIN
  PERFORM pg_temp.check('k10 catalogue fingerprint restored',
    pg_temp.fp() = current_setting('t3679.fp_before'), pg_temp.fp() || ' vs ' || current_setting('t3679.fp_before'));
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set role='broker' where id='{m_member}'$q$);
  PERFORM pg_temp.check('k10 after rollback: pre-migration behaviour (admin edit errors again)', m LIKE 'ERR 42501 permission denied for table users%', m);
END $$;
