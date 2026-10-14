-- BACKLOG-3946: production's catalogue state for every object the three migrations touch or
-- that calls one of the seven identity helpers (read 2026-10-14 via catalogue SELECT).
--   fn  <regprocedure>      md5(prosrc)|sorted ACL|SECURITY DEFINER|volatility|proconfig
--   pol <table>.<policy>    roles|cmd|md5(qual#with_check)
-- pg_temp.prod3946() is that list; pg_temp.venue3946() reads the same keys from the venue.
-- lib/pins-3946.sql compares all of them; controls/r0*.sql compare subsets after a rollback.
CREATE FUNCTION pg_temp.prod3946() RETURNS TABLE(k text, v text) LANGUAGE sql IMMUTABLE AS $f$ VALUES
 ('fn get_user_org_ids(uuid)','b2689c41c3b9f99b94a0404a96cfbde3|{=X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}|true|s|search_path=public'),
 ('fn get_user_permissions(uuid)','4717f97631e5a1415f85159f29d4b1fe|{=X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}|true|s|search_path=public'),
 ('fn guard_invite_acceptance()','9c8dc13e3fdece7c68e4d09870216efd|{postgres=X/postgres,service_role=X/postgres}|false|v|search_path=public, pg_temp'),
 ('fn has_any_permission(uuid,text[])','a24e9b03aeecfaf8c5884cf81da6d5a4|{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}|true|s|search_path=public'),
 ('fn has_internal_role(uuid)','e05a0db9fcbbb8d19bc8c17cc9e24ed7|{=X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}|true|s|search_path=public'),
 ('fn has_permission(uuid,text)','b5af01878cfcdaf4ef1a3d40f4b617e9|{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}|true|s|search_path=public'),
 ('fn is_org_admin(uuid,uuid)','e45b66de52f2f2dfa4d55165c6eb1796|{=X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}|true|s|search_path=public'),
 ('fn is_super_admin(uuid)','0cdf6aca14b003cde0936fe1aec5be07|{=X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}|true|s|search_path=public'),
 ('pol account_suspensions.account_suspensions_internal_select','{authenticated}|SELECT|64c9ab3fb6f42158bb94b5aad61ce22c'),
 ('pol admin_audit_logs.Internal users can view admin audit logs','{public}|SELECT|9da76ab7b273b4239b8e09f8ae7eef73'),
 ('pol admin_permissions.Internal users can view permissions','{public}|SELECT|9da76ab7b273b4239b8e09f8ae7eef73'),
 ('pol admin_role_permissions.Internal users can view role permissions','{public}|SELECT|9da76ab7b273b4239b8e09f8ae7eef73'),
 ('pol admin_roles.Internal users can view roles','{public}|SELECT|9da76ab7b273b4239b8e09f8ae7eef73'),
 ('pol analytics_events.analytics_events_select_own_or_internal','{public}|SELECT|15aa8a616cb0ae069da411d4283983c0'),
 ('pol audit_logs.audit_logs_select_public','{public}|SELECT|15aa8a616cb0ae069da411d4283983c0'),
 ('pol checklist_template_items.checklist_template_items_select_member','{authenticated}|SELECT|44b7f13aeeab337da6fce59b98d07364'),
 ('pol checklist_templates.checklist_templates_select_member','{authenticated}|SELECT|2222218e1105bc4b6be260d48a0155f1'),
 ('pol credit_ledger.credit_ledger_select_own','{public}|SELECT|15aa8a616cb0ae069da411d4283983c0'),
 ('pol devices.devices_select_public','{public}|SELECT|15aa8a616cb0ae069da411d4283983c0'),
 ('pol email_delivery_queue.email_delivery_queue internal read','{authenticated}|SELECT|9da76ab7b273b4239b8e09f8ae7eef73'),
 ('pol impersonation_sessions.Internal users can view their own sessions','{public}|SELECT|914a07b1e2d27e7eb92ffaa5ec72da0e'),
 ('pol individual_invitations.internal_users_can_read_individual_invitations','{public}|SELECT|9da76ab7b273b4239b8e09f8ae7eef73'),
 ('pol internal_roles.Super admins can manage internal roles','{public}|ALL|83a25c2e7555f7d39cd005ab22977204'),
 ('pol licenses.licenses_select_public','{public}|SELECT|15aa8a616cb0ae069da411d4283983c0'),
 ('pol organization_members.organization_members_all_public','{public}|ALL|3b07900ea089c4895d02c48082ddcdfa'),
 ('pol organization_members.organization_members_select_public','{public}|SELECT|42e9be91f2c826678579b8cd747a784f'),
 ('pol organization_plans.internal_users_can_read_org_plans','{public}|SELECT|9da76ab7b273b4239b8e09f8ae7eef73'),
 ('pol organization_plans.organization_plans_select_authenticated','{authenticated}|SELECT|9b181be5c6f9012f0deec1b3081ced4e'),
 ('pol organizations.organizations_select_public','{public}|SELECT|db849193bd986502dc47bc83c4251e2e'),
 ('pol payment_intents.payment_intents_select_own','{public}|SELECT|15aa8a616cb0ae069da411d4283983c0'),
 ('pol pending_internal_invitations.internal_users_can_manage_invitations','{public}|ALL|5db284f03211ea2c715a55925f8b39da'),
 ('pol stripe_customers.stripe_customers_select_own','{public}|SELECT|2f300c9c5f183bb77a5a2e78cb4ad9eb'),
 ('pol support_ticket_backlog_links.support_ticket_backlog_links_internal_all','{authenticated}|ALL|5db284f03211ea2c715a55925f8b39da'),
 ('pol transaction_unlocks.transaction_unlocks_select_own','{public}|SELECT|15aa8a616cb0ae069da411d4283983c0'),
 ('pol user_preferences.user_preferences_select_internal','{public}|SELECT|9da76ab7b273b4239b8e09f8ae7eef73'),
 ('pol users.users_select_public','{public}|SELECT|b3f601a1c81694a6e9f660ab97367226')
$f$;
CREATE FUNCTION pg_temp.venue3946() RETURNS TABLE(k text, v text) LANGUAGE sql STABLE AS $f$
  SELECT 'fn '||p.oid::regprocedure::text, md5(p.prosrc)||'|'||(SELECT '{'||string_agg(a::text, ',' ORDER BY a::text)||'}' FROM unnest(p.proacl) a)||'|'||p.prosecdef::text||'|'||p.provolatile::text||'|'||coalesce(array_to_string(p.proconfig,','),'')
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('has_internal_role','has_permission','get_user_org_ids','is_org_admin','is_super_admin','get_user_permissions','has_any_permission','guard_invite_acceptance')
  UNION ALL SELECT 'pol '||tablename||'.'||policyname, roles::text||'|'||cmd||'|'||md5(coalesce(qual,'')||'#'||coalesce(with_check,''))
    FROM pg_policies WHERE schemaname='public' AND (coalesce(qual,'')||coalesce(with_check,'')) ~ '(has_internal_role|has_permission|get_user_org_ids|is_org_admin|is_super_admin|get_user_permissions|has_any_permission)'
$f$;
-- Table grants on support_ticket_backlog_links for anon and authenticated, one string.
CREATE FUNCTION pg_temp.links_grants3946() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT coalesce(string_agg(grantee||':'||privs, ' ' ORDER BY grantee), '<none>') FROM (
    SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) privs
      FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name='support_ticket_backlog_links' AND grantee IN ('anon','authenticated')
     GROUP BY grantee) x
$f$;
