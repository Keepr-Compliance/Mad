-- harness: rollback
-- K11b: after rollback-3843.sql the catalogue matches the fingerprint taken
-- before the 3843 file, and the old admin write is accepted again.
DO $$ DECLARE m text; BEGIN
  PERFORM pg_temp.check('k31 catalogue fingerprint restored',
    pg_temp.fp3843() = current_setting('t3843.fp_before'), pg_temp.fp3843() || ' vs ' || current_setting('t3843.fp_before'));
  PERFORM pg_temp.check('k31 guard definition is the production one again',
    pg_temp.guard_md5() = 'a3eb55b807448a50e1c5f4228ef4e3b5', pg_temp.guard_md5());
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organization_members set license_status='suspended', updated_at=now() where id='{m_member}'$q$);
  PERFORM pg_temp.check('k31 after rollback: admin deactivate accepted again', m = 'OK rows=1', m);
END $$;
