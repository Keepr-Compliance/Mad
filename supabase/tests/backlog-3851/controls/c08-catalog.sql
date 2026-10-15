-- c08 catalogue after M1: grants, definer flags, search_path, volatility, trigger order and
-- columns, lock clause, CHECK, new column; every fingerprint row M1 does not touch still
-- equals production (auto_provision_google_it_admin and auto_provision_it_admin included).
CREATE TEMP TABLE t08_fn (sig text, definer boolean, vol "char", acl_auth boolean, acl_service boolean) ON COMMIT DROP;
INSERT INTO t08_fn VALUES
  ('public.member_status_holds_seat(text)', false, 'i', true, true),
  ('public.member_status_is_deactivated(text)', false, 'i', true, true),
  ('public.member_origin_is_idp(text)', false, 'i', true, true),
  ('public.member_row_holds_seat(text,timestamp with time zone,uuid)', false, 's', true, true),
  ('public._enforce_member_seat_limit()', true, 'v', false, true),
  ('public.set_member_license(uuid,text)', true, 'v', true, true);
SELECT pg_temp.check('c08 ' || f.sig || ' exists', p.oid IS NOT NULL, NULL)
  FROM t08_fn f LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.sig);
SELECT pg_temp.check('c08 ' || f.sig || ' no PUBLIC / anon EXECUTE',
  NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND coalesce(p.proacl::text, '') NOT LIKE '%{=X%' AND coalesce(p.proacl::text, '') NOT LIKE '%,=X%',
  p.proacl::text)
  FROM t08_fn f JOIN pg_proc p ON p.oid = to_regprocedure(f.sig);
SELECT pg_temp.check('c08 ' || f.sig || ' authenticated EXECUTE = ' || f.acl_auth,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') = f.acl_auth, p.proacl::text)
  FROM t08_fn f JOIN pg_proc p ON p.oid = to_regprocedure(f.sig);
SELECT pg_temp.check('c08 ' || f.sig || ' service_role EXECUTE',
  has_function_privilege('service_role', p.oid, 'EXECUTE') = f.acl_service, p.proacl::text)
  FROM t08_fn f JOIN pg_proc p ON p.oid = to_regprocedure(f.sig);
SELECT pg_temp.check('c08 ' || f.sig || ' definer=' || f.definer || ' volatility=' || f.vol::text || ' search_path=''''',
  p.prosecdef = f.definer AND p.provolatile = f.vol AND p.proconfig = ARRAY['search_path=""'],
  p.prosecdef::text || ' ' || p.provolatile::text || ' ' || coalesce(p.proconfig::text, '<none>'))
  FROM t08_fn f JOIN pg_proc p ON p.oid = to_regprocedure(f.sig);

-- Replaced functions keep production's ACL.
CREATE TEMP TABLE t08_acl (sig text, acl text) ON COMMIT DROP;
INSERT INTO t08_acl VALUES
  ('public.guard_invite_acceptance()', '{postgres=X/postgres,service_role=X/postgres}'),
  ('public.admin_invite_user(uuid,text,text,uuid,text,uuid)', '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
  ('public.get_org_features(uuid)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
  ('public.check_feature_access(uuid,text)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}');
SELECT pg_temp.check('c08 ' || a.sig || ' ACL unchanged', p.proacl::text = a.acl, p.proacl::text)
  FROM t08_acl a JOIN pg_proc p ON p.oid = to_regprocedure(a.sig);
SELECT pg_temp.check('c08 anon calling set_member_license is refused (42501)',
  pg_temp.as_role('anon', NULL, format('select public.set_member_license(%L::uuid, %L)', pg_temp.id('o_tact'), 'unassign')) LIKE 'ERR 42501%', NULL);

-- Trigger: BEFORE order guard (g) < seat (s) < updated_at (u); columns; enabled.
SELECT pg_temp.check('c08 BEFORE triggers on organization_members in order',
  (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger
    WHERE tgrelid = 'public.organization_members'::regclass AND NOT tgisinternal AND (tgtype & 2) = 2)
  = 'guard_invite_acceptance,seat_limit_enforce,update_org_members_updated_at',
  (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.organization_members'::regclass AND NOT tgisinternal AND (tgtype & 2) = 2));
SELECT pg_temp.check('c08 seat trigger definition',
  pg_get_triggerdef(t.oid) = 'CREATE TRIGGER seat_limit_enforce BEFORE INSERT OR UPDATE OF license_status, organization_id, invitation_expires_at, user_id, license_assigned_at ON public.organization_members FOR EACH ROW EXECUTE FUNCTION _enforce_member_seat_limit()'
  AND t.tgenabled = 'O', pg_get_triggerdef(t.oid))
  FROM pg_trigger t WHERE t.tgrelid = 'public.organization_members'::regclass AND t.tgname = 'seat_limit_enforce';
SELECT pg_temp.check('c08 seat lock is FOR NO KEY UPDATE, taken before the count',
  p.prosrc LIKE '%FOR NO KEY UPDATE;%' AND p.prosrc NOT LIKE '%    FOR UPDATE;%'
  AND strpos(p.prosrc, 'FOR NO KEY UPDATE') < strpos(p.prosrc, 'INTO v_used'), NULL)
  FROM pg_proc p WHERE p.oid = to_regprocedure('public._enforce_member_seat_limit()');
SELECT pg_temp.check('c08 set_member_license locks the organization FOR NO KEY UPDATE before the caller check',
  strpos(p.prosrc, 'FOR NO KEY UPDATE') > 0 AND strpos(p.prosrc, 'FOR NO KEY UPDATE') < strpos(p.prosrc, 'INTO v_caller_role'), NULL)
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_member_license(uuid,text)');

-- CHECK: exactly the five statuses.
SELECT pg_temp.check('c08 license_status CHECK = pending, active, suspended, expired, unassigned',
  pg_get_constraintdef(c.oid) = 'CHECK (((license_status)::text = ANY ((ARRAY[''pending''::character varying, ''active''::character varying, ''suspended''::character varying, ''expired''::character varying, ''unassigned''::character varying])::text[])))',
  pg_get_constraintdef(c.oid))
  FROM pg_constraint c WHERE c.conrelid = 'public.organization_members'::regclass AND c.conname = 'organization_members_license_status_check';
SELECT pg_temp.check('c08 license_assigned_at timestamptz NULL, no default',
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organization_members'
           AND column_name = 'license_assigned_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES' AND column_default IS NULL), NULL);

-- Everything M1 does not touch still equals production.
SELECT pg_temp.check('c08 untouched object equals production: ' || p.k, v.v IS NOT DISTINCT FROM p.v, coalesce(v.v, '<none>'))
  FROM t3851_prod p LEFT JOIN pg_temp.venue3851() v ON v.k = p.k
 WHERE p.k NOT IN ('cols organization_members', 'con organization_members_license_status_check',
                   'fn guard_invite_acceptance()', 'fn admin_invite_user(uuid,text,text,uuid,text,uuid)',
                   'fn get_org_features(uuid)', 'fn check_feature_access(uuid,text)');
