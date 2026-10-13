-- C08: identity providers, SCIM tokens and SCIM sync logs (the four policies
-- that already required 'active', now through the helper): a suspended/expired
-- it_admin reads none, the active it_admin reads all.
DO $$ DECLARE st text; actor text; m text; deny boolean; x text; parts text[];
  q text[] := ARRAY[
    'identity providers|select (select count(*) from public.organization_identity_providers where organization_id=''{org1}'')',
    'scim tokens|select (select count(*) from public.scim_tokens where organization_id=''{org1}'')',
    'scim sync log|select (select count(*) from public.scim_sync_log where organization_id=''{org1}'')'];
BEGIN
  FOREACH st IN ARRAY ARRAY['suspended', 'expired', 'active'] LOOP
    actor := CASE WHEN st = 'active' THEN 'u_ta' ELSE 'u_ts' END;
    IF st <> 'active' THEN PERFORM pg_temp.set_status('m_ts', st); END IF;
    deny := st <> 'active';
    FOREACH x IN ARRAY q LOOP
      parts := string_to_array(x, '|');
      m := pg_temp.as_user(actor, parts[2]);
      PERFORM pg_temp.check('c08 '||st||' it_admin: '||parts[1]||' = '||CASE WHEN deny THEN '0' ELSE '1' END,
        m = 'OK '||CASE WHEN deny THEN '0' ELSE '1' END, m);
    END LOOP;
    m := pg_temp.as_user(actor, $q$update public.scim_tokens set token_hash='h2' where id='{tok}'$q$);
    PERFORM pg_temp.check('c08 '||st||' it_admin: SCIM token write '||CASE WHEN deny THEN 'refused' ELSE 'allowed' END,
      CASE WHEN deny THEN pg_temp.refused(m) ELSE m = 'OK rows=1' END, m);
  END LOOP;
END $$;
