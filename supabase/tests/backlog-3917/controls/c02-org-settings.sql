-- C02: organization settings (admins_can_modify_org) are writable only by an
-- admin whose membership grants access.
DO $$ DECLARE st text; actor text; m text; deny boolean; BEGIN
  FOREACH st IN ARRAY ARRAY['suspended', 'expired', 'active'] LOOP
    actor := CASE WHEN st = 'active' THEN 'u_a' ELSE 'u_s' END;
    IF st <> 'active' THEN PERFORM pg_temp.set_status('m_s', st); END IF;
    deny := st <> 'active';
    m := pg_temp.as_user(actor, $q$update public.organizations set retention_years = 3 where id='{org1}'$q$);
    PERFORM pg_temp.check('c02 '||st||' admin: retention '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
    m := pg_temp.as_user(actor, $q$update public.organizations set jit_provisioning_enabled = true where id='{org1}'$q$);
    PERFORM pg_temp.check('c02 '||st||' admin: JIT setting '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
  END LOOP;
END $$;
