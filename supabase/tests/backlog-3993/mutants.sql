-- BACKLOG-3993 mutant run. Same fixtures and controls as controls.sql, run once per
-- mutant of the LIVE body, each mutant inside its own subtransaction (undone after its
-- controls), and the whole block ends with RAISE EXCEPTION (self-rolled-back).
-- A mutant counts only when its anchor occurs exactly once in pg_get_functiondef and
-- the md5 changed; the report prints MUTATION APPLIED with both md5s.
--   M1  org path:        predicate back to license_status = 'pending'
--   M1b individual path: predicate back to license_status = 'pending'
--   M2  org path:        drop "AND om.user_id IS NULL"
--   M2b individual path: drop "AND om.user_id IS NULL"
--   M3  org path:        the new predicate without its outer parentheses
--   M3b individual path: the new predicate without its outer parentheses
-- mutate.py does the same exact-once check against the repo body offline.
DO $mutants$
DECLARE
  v_staff  uuid := gen_random_uuid();
  v_claim  uuid := gen_random_uuid();
  v_role   uuid := gen_random_uuid();
  v_org_a  uuid := gen_random_uuid();
  v_org_b  uuid := gen_random_uuid();
  v_report text := '';
  v_r      jsonb;
  v_def    text;
  v_before text;
  v_after  text;
  v_o      text;
  v_m      text;
  v_tail   text := E'\n    FROM organization_members om\n    JOIN organizations o ON o.id = om.organization_id\n    WHERE om.invited_email = p_email\n      AND (om.license_status = ''pending''\n           OR (om.license_status = ''unassigned'' AND om.user_id IS NULL))';
  v_org    text := E'-- Check duplicate across OTHER orgs (unclaimed invites: ''pending'', or ''unassigned'' with no user)\n    SELECT om.organization_id, o.name INTO v_existing_org_id, v_existing_org_name';
  v_ind    text := E'-- Cross-table check — also check organization_members for an unclaimed invite (''pending'', or ''unassigned'' with no user)\n    SELECT om.organization_id, o.name INTO v_existing_org_id, v_existing_org_name';
  v_pred   text := E'AND (om.license_status = ''pending''\n           OR (om.license_status = ''unassigned'' AND om.user_id IS NULL))';
  mu       record;
  c        record;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data) VALUES
    (v_staff, 'staff-3993@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{"provider":"azure","providers":["azure"]}'::jsonb),
    (v_claim, 'c3-3993@example.test',    'authenticated', 'authenticated', '{}'::jsonb, '{"provider":"azure","providers":["azure"]}'::jsonb);
  INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES
    (v_staff, 'staff-3993@example.test', 'azure', 'oauth-3993-staff'),
    (v_claim, 'c3-3993@example.test',    'azure', 'oauth-3993-c3')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.admin_permissions (key, label, category)
    SELECT 'users.edit', 'users.edit', 'probe'
     WHERE NOT EXISTS (SELECT 1 FROM public.admin_permissions WHERE key = 'users.edit');
  INSERT INTO public.admin_roles (id, name, slug, is_system) VALUES (v_role, 'Staff 3993', 'staff-3993', false);
  INSERT INTO public.admin_role_permissions (role_id, permission_id)
    SELECT v_role, id FROM public.admin_permissions WHERE key = 'users.edit';
  INSERT INTO public.internal_roles (user_id, role_id) VALUES (v_staff, v_role);
  INSERT INTO public.organizations (id, name, slug, max_seats) VALUES
    (v_org_a, 'Happyhomey Test 3993 A', 'happyhomey-test-3993-a', 10),
    (v_org_b, 'Happyhomey Test 3993 B', 'happyhomey-test-3993-b', 10);

  -- Neutralise leftover unclaimed invites on the shared test database, so no control
  -- depends on what earlier runs or other work left behind (rolled back with the rest).
  DELETE FROM public.organization_members WHERE user_id IS NULL AND license_status IN ('pending', 'unassigned');

  FOR mu IN SELECT * FROM (VALUES
    ('M1',  'org', E'AND (om.license_status = ''pending'')'),
    ('M1b', 'ind', E'AND (om.license_status = ''pending'')'),
    ('M2',  'org', E'AND (om.license_status = ''pending''\n           OR (om.license_status = ''unassigned''))'),
    ('M2b', 'ind', E'AND (om.license_status = ''pending''\n           OR (om.license_status = ''unassigned''))'),
    ('M3',  'org', E'AND om.license_status = ''pending''\n           OR (om.license_status = ''unassigned'' AND om.user_id IS NULL)'),
    ('M3b', 'ind', E'AND om.license_status = ''pending''\n           OR (om.license_status = ''unassigned'' AND om.user_id IS NULL)')
  ) AS t(name, site, pred) LOOP
    BEGIN
      v_def := pg_get_functiondef('public.admin_invite_user(uuid,text,text,uuid,text,uuid)'::regprocedure);
      v_before := md5(v_def);
      v_o := CASE mu.site WHEN 'org' THEN v_org ELSE v_ind END || v_tail;
      v_m := replace(v_o, v_pred, mu.pred);
      IF (length(v_def) - length(replace(v_def, v_o, ''))) / length(v_o) <> 1 THEN
        RAISE EXCEPTION 'mutant %: anchor not exactly once', mu.name;
      END IF;
      EXECUTE replace(v_def, v_o, v_m);
      v_after := md5(pg_get_functiondef('public.admin_invite_user(uuid,text,text,uuid,text,uuid)'::regprocedure));
      IF v_after <> md5(replace(v_def, v_o, v_m)) THEN RAISE EXCEPTION 'mutant %: live md5 % <> intended %', mu.name, v_after, md5(replace(v_def, v_o, v_m)); END IF;
      IF v_after = v_before THEN RAISE EXCEPTION 'mutant %: md5 unchanged', mu.name; END IF;
      v_report := v_report || E'\n' || 'MUTATION APPLIED ' || mu.name || ' (md5 ' || v_before || ' -> ' || v_after || ')';

      FOR c IN SELECT * FROM (VALUES
        ('C0',  'none',               'c0-3993@example.test',  'c0-3993@example.test',    'B',   'success'),
        ('C1',  'unassigned',         'c1-3993@example.test',  'c1-3993@example.test',    'B',   'duplicate_invitation'),
        ('C2',  'pending',            'c2-3993@example.test',  'c2-3993@example.test',    'B',   'duplicate_invitation'),
        ('C3',  'claimed_unassigned', 'c3-3993@example.test',  'c3-3993@example.test',    'B',   'success'),
        ('C4a', 'pending_expired',    'c4a-3993@example.test', 'c4a-3993@example.test',   'B',   'duplicate_invitation'),
        ('C4b', 'unassigned_expired', 'c4b-3993@example.test', 'c4b-3993@example.test',   'B',   'duplicate_invitation'),
        ('C5',  'unassigned_revoked', 'c5-3993@example.test',  'c5-3993@example.test',    'B',   'success'),
        ('C6',  'unassigned',         'c6-3993@example.test',  '  C6-3993@Example.TEST ', 'B',   'duplicate_invitation'),
        ('C7',  'unassigned',         'c7-3993@example.test',  'c7-3993@example.test',    'IND', 'duplicate_invitation'),
        ('C8',  'pending',            'c8-3993@example.test',  'c8-3993@example.test',    'IND', 'duplicate_invitation'),
        ('C9',  'none',               'c9-3993@example.test',  'c9-3993@example.test',    'IND', 'success'),
        ('C10', 'claimed_unassigned', 'c3-3993@example.test',  'c3-3993@example.test',    'IND', 'success'),
        ('C11', 'bystander',          'c11-other-3993@example.test', 'c11-3993@example.test', 'B',   'success'),
        ('C11i','bystander',          'c11-other-3993@example.test', 'c11-3993@example.test', 'IND', 'success')
      ) AS t(name, state, stored, asked, target, expect) LOOP
        BEGIN
          IF c.state IN ('pending', 'unassigned', 'pending_expired', 'unassigned_expired', 'unassigned_revoked') THEN
            INSERT INTO public.organization_members (organization_id, invited_email, role, license_status,
                                                     invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by)
            VALUES (v_org_a, c.stored, 'agent',
                    CASE WHEN c.state LIKE 'pending%' THEN 'pending' ELSE 'unassigned' END,
                    'tok-3993-' || md5(c.name),
                    CASE WHEN c.state LIKE '%expired' THEN now() - interval '1 day' ELSE now() + interval '3 days' END,
                    v_staff, now() - interval '8 days', 'invite');
            IF c.state = 'unassigned_revoked' THEN
              DELETE FROM public.organization_members WHERE organization_id = v_org_a AND invited_email = c.stored;
            END IF;
          ELSIF c.state = 'bystander' THEN
            INSERT INTO public.organization_members (organization_id, invited_email, role, license_status,
                                                     invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by)
            VALUES (v_org_a, c.stored, 'agent', 'unassigned', 'tok-3993-' || md5(c.name), now() + interval '3 days',
                    v_staff, now() - interval '8 days', 'invite');
          ELSIF c.state = 'claimed_unassigned' THEN
            INSERT INTO public.organization_members (organization_id, invited_email, user_id, role, license_status,
                                                     invitation_token, invitation_expires_at, invited_by, invited_at,
                                                     joined_at, provisioned_by)
            VALUES (v_org_a, c.stored, v_claim, 'agent', 'unassigned', NULL, now() + interval '3 days',
                    v_staff, now() - interval '1 day', now(), 'invite');
          END IF;

          PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
          PERFORM set_config('role', 'authenticated', true);
          v_r := public.admin_invite_user(CASE WHEN c.target = 'B' THEN v_org_b END, c.asked, 'agent', v_staff);
          PERFORM set_config('role', 'postgres', true);
          PERFORM set_config('request.jwt.claims', '', true);

          IF NOT ((CASE WHEN (v_r->>'success')::boolean THEN 'success' ELSE coalesce(v_r->>'error', '<none>') END) = c.expect
                  AND (c.expect <> 'duplicate_invitation' OR c.target = 'IND' OR (v_r->>'existing_org_id')::uuid = v_org_a)) THEN
            v_report := v_report || ' ' || c.name || '=RED';
          END IF;
          RAISE EXCEPTION USING ERRCODE = 'P3993', MESSAGE = 'undo control';
        EXCEPTION
          WHEN SQLSTATE 'P3993' THEN NULL;
          WHEN OTHERS THEN
            PERFORM set_config('role', 'postgres', true);
            v_report := v_report || ' ' || c.name || '=ERR ' || SQLSTATE;
        END;
      END LOOP;
      RAISE EXCEPTION USING ERRCODE = 'P3994', MESSAGE = 'undo mutant';
    EXCEPTION
      WHEN SQLSTATE 'P3994' THEN NULL;
      WHEN OTHERS THEN v_report := v_report || E'\n' || mu.name || ' NOT RUN: ' || SQLERRM;
    END;
  END LOOP;

  RAISE EXCEPTION 'MUTANTS 3993 (live md5 %)%',
    md5(pg_get_functiondef('public.admin_invite_user(uuid,text,text,uuid,text,uuid)'::regprocedure)), v_report;
END $mutants$;
