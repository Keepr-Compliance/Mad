-- Every object 3938/3940 touches or calls must equal production (read 2026-10-14).
DO $pin$ DECLARE bad text; BEGIN
  WITH prod(k, v) AS (VALUES
    ('fn broker_get_org_features(uuid)', 'b61e499f7c1c0ed83f551c0cc46707a0'),
    ('fn get_user_org_ids(uuid)', '46e19a432fe087843e6442f6da7e0e36'),
    ('fn is_org_admin(uuid,uuid)', '325f08f47d5266c3dceb85ca39ab1dba'),
    ('fn has_internal_role(uuid)', '95139da049122e52829207b4413112c2'),
    ('fn member_status_grants_access(text)', 'ad3b156603a260785e12361e1173c216'),
    ('fn guard_invite_acceptance()', '319e828acbc68df5b033a37e59e4e4c0'),
    ('fn _override_effective(jsonb)', 'cb055e359414626933d89459ed9c3e25'),
    ('fn _override_above_tier(text,text,text,jsonb)', 'fe9780776607322aee910479e4a119c8'),
    ('acl broker_get_org_features(uuid)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('acl get_user_org_ids(uuid)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('acl is_org_admin(uuid,uuid)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('acl has_internal_role(uuid)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('pol checklist_template_items.checklist_template_items_select_member', '{authenticated}|48393f429533ace84547fffca5965278'),
    ('pol checklist_templates.checklist_templates_select_member', '{authenticated}|4ce61bebbd6ef78bc3ee001464cd139a'),
    ('pol organization_members.organization_members_all_public', '{public}|135e6de7e3929c7484733ab80ff95c2b'),
    ('pol organization_members.organization_members_select_public', '{public}|45dcc840cdfed4ac458e4d9b0724002c'),
    ('pol organization_members.users_can_accept_invite', '{authenticated}|65c5e8b1007f477c1eff232b959e93e7'),
    ('pol organization_members.users_can_view_own_invite', '{authenticated}|dfc93536d3e7a12d68319f1dd279ff29'),
    ('pol support_ticket_backlog_links.Admins can manage links', '{public}|84ac569390eb4ead7da1723cd89a0467'),
    ('pol support_ticket_backlog_links.Authenticated users can read links', '{public}|97caa439c76824f55cc97930a41fb789'),
    ('trg guard_invite_acceptance', 'CREATE TRIGGER guard_invite_acceptance BEFORE INSERT OR UPDATE ON public.organization_members FOR EACH ROW EXECUTE FUNCTION guard_invite_acceptance()')),
  venue(k, v) AS (
    SELECT 'fn ' || p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)) FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('broker_get_org_features','get_user_org_ids','is_org_admin',
       'has_internal_role','member_status_grants_access','guard_invite_acceptance','_override_effective','_override_above_tier')
    UNION ALL SELECT 'acl ' || p.oid::regprocedure::text, p.proacl::text FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('broker_get_org_features','get_user_org_ids','is_org_admin','has_internal_role')
    UNION ALL SELECT 'pol ' || tablename || '.' || policyname, roles::text || '|' || md5(coalesce(qual,'') || '|' || coalesce(with_check,''))
      FROM pg_policies WHERE tablename IN ('organization_members','support_ticket_backlog_links','checklist_templates','checklist_template_items')
       AND (tablename IN ('organization_members','support_ticket_backlog_links') OR policyname LIKE '%select_member')
    UNION ALL SELECT 'trg ' || tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'guard_invite_acceptance')
  SELECT string_agg(coalesce(v.k, p.k) || ' venue=' || coalesce(v.v, '<missing>') || ' prod=' || coalesce(p.v, '<missing>'), '; ')
    INTO bad FROM venue v FULL JOIN prod p ON p.k = v.k WHERE v.v IS DISTINCT FROM p.v;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'pin: venue differs from production: %', bad; END IF;
END $pin$;
SELECT 'PINS OK' ;
