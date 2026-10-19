-- BACKLOG-3993 controls: admin_invite_user's cross-organisation duplicate check.
--
-- One DO block. It builds its fixtures, runs each control in its own subtransaction,
-- and ends with RAISE EXCEPTION carrying the report, so NOTHING it writes survives
-- (self-rolled-back). Run on keepr-test through execute_sql; read the report from the
-- error text. Each report line: PASS|name|detail or FAIL|name|detail.
-- Mutants: mutants.sql (same fixtures and controls, one subtransaction per mutant).
--
-- Fixture shapes (transcribed, not invented):
--   unclaimed invite: broker-portal/lib/actions/inviteUser.ts insert (invited_email,
--     role, license_status 'pending' | 'unassigned', token, expiry, provisioned_by 'invite');
--   claimed unlicensed member: accept_invitation(text,text) on keepr-test sets user_id,
--     license_status 'unassigned' (kept), joined_at, invitation_token NULL and leaves
--     invited_email on the row;
--   revoked invite: broker-portal/lib/actions/removeUser.ts deletes the row;
--   staff caller: supabase/tests/backlog-3851/lib/fixtures-3851.sql u_st (internal_roles
--     row whose admin role holds users.edit).
-- Emails are example.test.
DO $controls$
DECLARE
  v_staff  uuid := gen_random_uuid();
  v_claim  uuid := gen_random_uuid();
  v_role   uuid := gen_random_uuid();
  v_org_a  uuid := gen_random_uuid();
  v_org_b  uuid := gen_random_uuid();
  v_report text := '';
  v_r      jsonb;
  v_md5    text;
  c        record;
BEGIN
  SELECT md5(pg_get_functiondef('public.admin_invite_user(uuid,text,text,uuid,text,uuid)'::regprocedure)) INTO v_md5;

  -- Fixtures (all inside this transaction).
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data) VALUES
    (v_staff, 'staff-3993@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{"provider":"azure","providers":["azure"]}'::jsonb),
    (v_claim, 'c3-3993@example.test',    'authenticated', 'authenticated', '{}'::jsonb, '{"provider":"azure","providers":["azure"]}'::jsonb);
  INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES
    (v_staff, 'staff-3993@example.test', 'azure', 'oauth-3993-staff'),
    (v_claim, 'c3-3993@example.test',    'azure', 'oauth-3993-c3')
  ON CONFLICT DO NOTHING;  -- keepr-test's auth.users trigger may already have made these rows
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

  -- Each control: optional row in org A (state), then the call, then the expectation.
  --   state: none | pending | unassigned | pending_expired | unassigned_expired
  --          | claimed_unassigned | unassigned_revoked
  --   target: 'B' (org path into org B) or 'IND' (individual path, p_organization_id NULL)
  FOR c IN SELECT * FROM (VALUES
    ('C0 fresh address, org path -> success (auth plumbing works)',            'none',               'c0-3993@example.test',  'c0-3993@example.test',      'B',   'success'),
    ('C1 unclaimed unassigned invite in A, invite to B -> duplicate_invitation', 'unassigned',         'c1-3993@example.test',  'c1-3993@example.test',      'B',   'duplicate_invitation'),
    ('C2 unclaimed pending invite in A, invite to B -> duplicate_invitation',    'pending',            'c2-3993@example.test',  'c2-3993@example.test',      'B',   'duplicate_invitation'),
    ('C3 claimed member in A (unassigned, user set), invite to B -> success',    'claimed_unassigned', 'c3-3993@example.test',  'c3-3993@example.test',      'B',   'success'),
    ('C4a expired pending invite in A, invite to B -> duplicate (today)',        'pending_expired',    'c4a-3993@example.test', 'c4a-3993@example.test',     'B',   'duplicate_invitation'),
    ('C4b expired unassigned invite in A, invite to B -> duplicate (same as C4a)','unassigned_expired', 'c4b-3993@example.test', 'c4b-3993@example.test',     'B',   'duplicate_invitation'),
    ('C5 unassigned invite in A revoked (row deleted), invite to B -> success',  'unassigned_revoked', 'c5-3993@example.test',  'c5-3993@example.test',      'B',   'success'),
    ('C6 unassigned in A, invite to B in mixed case + spaces -> duplicate',     'unassigned',         'c6-3993@example.test',  '  C6-3993@Example.TEST ',   'B',   'duplicate_invitation'),
    ('C7 unassigned in A, individual path -> duplicate_invitation',             'unassigned',         'c7-3993@example.test',  'c7-3993@example.test',      'IND', 'duplicate_invitation'),
    ('C8 pending in A, individual path -> duplicate_invitation',                'pending',            'c8-3993@example.test',  'c8-3993@example.test',      'IND', 'duplicate_invitation'),
    ('C9 fresh address, individual path -> success (plumbing)',                 'none',               'c9-3993@example.test',  'c9-3993@example.test',      'IND', 'success'),
    ('C10 claimed member in A (unassigned, user set), individual path -> success','claimed_unassigned', 'c3-3993@example.test',  'c3-3993@example.test',      'IND', 'success')
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

      v_report := v_report || E'\n'
        || CASE WHEN (CASE WHEN (v_r->>'success')::boolean THEN 'success' ELSE coalesce(v_r->>'error', '<none>') END) = c.expect
                 AND (c.expect <> 'duplicate_invitation' OR c.target = 'IND' OR (v_r->>'existing_org_id')::uuid = v_org_a)
                THEN 'PASS' ELSE 'FAIL' END
        || '|' || c.name || '|' || (v_r - 'invitation_token')::text;
      RAISE EXCEPTION USING ERRCODE = 'P3993', MESSAGE = 'undo control';
    EXCEPTION
      WHEN SQLSTATE 'P3993' THEN NULL;
      WHEN OTHERS THEN
        PERFORM set_config('role', 'postgres', true);
        v_report := v_report || E'\n' || 'FAIL|' || c.name || '|ERR ' || SQLSTATE || ' ' || SQLERRM;
    END;
  END LOOP;

  RAISE EXCEPTION 'REPORT 3993 (body md5 %)%', v_md5, v_report;
END $controls$;
