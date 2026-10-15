-- r02 after M1 + seed + rollback-3851.sql: every production pin is back except
-- 'cols organization_members' (license_assigned_at kept by design, the only difference);
-- unassigned rows became suspended; the revert-attached personal row survives (R7d).
SELECT pg_temp.check('r02 pin equals production: ' || p.k, v.v IS NOT DISTINCT FROM p.v, coalesce(v.v, '<none>'))
  FROM t3851_prod p LEFT JOIN pg_temp.venue3851() v ON v.k = p.k WHERE p.k <> 'cols organization_members';
SELECT pg_temp.check('r02 no object beyond production remains', NOT EXISTS (
  SELECT 1 FROM pg_temp.venue3851() v LEFT JOIN t3851_prod p ON p.k = v.k WHERE p.k IS NULL), NULL);
SELECT pg_temp.check('r02 organization_members differs from production only by license_assigned_at',
  (SELECT string_agg(column_name, ',') FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organization_members' AND column_name NOT IN (
      'id','organization_id','user_id','role','license_status','invited_email','invitation_token','invitation_expires_at','invited_by',
      'invited_at','joined_at','created_at','updated_at','last_invited_at','provisioned_by','provisioned_at','scim_synced_at',
      'provisioning_metadata','idp_groups','group_sync_enabled')) = 'license_assigned_at', NULL);
SELECT pg_temp.check('r02 no unassigned rows; the two seeded ones are suspended',
  NOT EXISTS (SELECT 1 FROM public.organization_members WHERE license_status = 'unassigned')
  AND pg_temp.status('f_un') = 'suspended' AND pg_temp.status('o_tun') = 'suspended', NULL);
SELECT pg_temp.check('r02 seat trigger gone: an over-limit insert is no longer refused',
  pg_temp.as_service(format('insert into public.organization_members (organization_id, invited_email, role, license_status, invitation_expires_at, provisioned_by) values (%L, %L, %L, %L, now() + interval ''7 days'', %L)',
    pg_temp.id('f_org'), 'r01-3851@example.test', 'agent', 'pending', 'invite')) = 'OK rows=1', NULL);
