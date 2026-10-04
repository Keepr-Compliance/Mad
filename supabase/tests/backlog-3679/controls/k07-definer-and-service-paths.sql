-- claim_pending_invite() (SECURITY DEFINER) and service_role writes are unaffected.
-- claim_pending_invite() takes the first pending row by email (LIMIT 1), so the
-- fixture's expired invite for the same email is removed first.
DELETE FROM public.organization_members WHERE id=pg_temp.id('inv_exp');
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test', $q$select public.claim_pending_invite()$q$);
  PERFORM pg_temp.check('k07 claim_pending_invite() accepts', m LIKE 'OK %"success": true%', m);
  m := pg_temp.as_role('service_role', NULL, NULL,
    $q$update public.organization_members set role='broker', scim_synced_at=now(), idp_groups=array['g'] where id='{inv_a}'$q$);
  PERFORM pg_temp.check('k07 service_role update unrestricted', m = 'OK rows=1', m);
  m := pg_temp.as_role('postgres', NULL, NULL,
    $q$update public.organization_members set organization_id='{org2}' where id='{m_member}'$q$);
  PERFORM pg_temp.check('k07 postgres update unrestricted', m = 'OK rows=1', m);
END $$;
