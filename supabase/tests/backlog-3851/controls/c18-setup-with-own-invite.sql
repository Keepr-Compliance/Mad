-- c18 (N4 trace) /setup (auto_provision_it_admin) for a user who also has their own
-- unclaimed invite in the same organization. auto_provision_it_admin matches existing
-- membership by user_id only, so the invite (user_id NULL) is not seen: a second, jit row
-- is inserted. claim_pending_invite later finds the jit row and deletes the invite.
-- A: room in the organization.
CREATE TEMP TABLE t18 (k text, v text) ON COMMIT DROP;
INSERT INTO t18 SELECT 'seats0', pg_temp.seats('o_org')::text;
INSERT INTO public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, provisioned_by)
VALUES (pg_temp.id('o_org'), 'u_n-3917@example.test', 'agent', 'pending', 'tok-3851-c18', now() + interval '3 days', 'invite');
INSERT INTO t18 SELECT 'prov', pg_temp.provision3851('u_n', 't_o') ->> 'success';
INSERT INTO t18 SELECT 'rows1', string_agg(license_status || ':' || coalesce(provisioned_by, '-') || ':' || (user_id IS NOT NULL)::text, ',' ORDER BY license_status)
  FROM public.organization_members WHERE organization_id = pg_temp.id('o_org') AND (user_id = pg_temp.id('u_n') OR invited_email = 'u_n-3917@example.test');
INSERT INTO t18 SELECT 'seats1', pg_temp.seats('o_org')::text;
INSERT INTO t18 SELECT 'claim', pg_temp.keep('authenticated', 'u_n', 'select public.claim_pending_invite() ->> ''note''');
INSERT INTO t18 SELECT 'rows2', string_agg(license_status || ':' || coalesce(provisioned_by, '-'), ',')
  FROM public.organization_members WHERE organization_id = pg_temp.id('o_org') AND (user_id = pg_temp.id('u_n') OR invited_email = 'u_n-3917@example.test');
INSERT INTO t18 SELECT 'seats2', pg_temp.seats('o_org')::text;
SELECT pg_temp.check('c18 A /setup with own invite: jit row active beside the pending invite',
  (SELECT v FROM t18 WHERE k = 'rows1') = 'active:jit:true,pending:invite:false', (SELECT v FROM t18 WHERE k = 'rows1'));
SELECT pg_temp.check('c18 A both rows hold a seat until the claim',
  (SELECT v::int FROM t18 WHERE k = 'seats1') = (SELECT v::int FROM t18 WHERE k = 'seats0') + 2, NULL);
SELECT pg_temp.check('c18 A claim keeps the jit row and deletes the invite',
  (SELECT v FROM t18 WHERE k = 'claim') = 'OK existing_membership_kept' AND (SELECT v FROM t18 WHERE k = 'rows2') = 'active:jit', (SELECT v FROM t18 WHERE k = 'rows2'));
SELECT pg_temp.check('c18 A seat count back to +1',
  (SELECT v::int FROM t18 WHERE k = 'seats2') = (SELECT v::int FROM t18 WHERE k = 'seats0') + 1, NULL);
-- B: full organization, and the user's own live invite is one of the seats (f_il / u_fil).
DELETE FROM t18;
INSERT INTO t18 SELECT 'prov', pg_temp.provision3851('u_fil', 't_f') ->> 'success';
INSERT INTO t18 SELECT 'jit', license_status FROM public.organization_members WHERE organization_id = pg_temp.id('f_org') AND user_id = pg_temp.id('u_fil');
INSERT INTO t18 SELECT 'claim', pg_temp.keep('authenticated', 'u_fil', 'select public.claim_pending_invite() ->> ''note''');
INSERT INTO t18 SELECT 'after', license_status FROM public.organization_members WHERE organization_id = pg_temp.id('f_org') AND user_id = pg_temp.id('u_fil');
INSERT INTO t18 SELECT 'invite', count(*)::text FROM public.organization_members WHERE id = pg_temp.id('f_il');
INSERT INTO t18 SELECT 'seats', pg_temp.seats('f_org')::text;
SELECT pg_temp.check('c18 B /setup in a full org whose seat is the user''s own invite -> unassigned',
  (SELECT v FROM t18 WHERE k = 'jit') = 'unassigned', (SELECT v FROM t18 WHERE k = 'jit'));
SELECT pg_temp.check('c18 B claim deletes the invite; the user stays unassigned; one seat free (no auto-assign, Q5)',
  (SELECT v FROM t18 WHERE k = 'claim') = 'OK existing_membership_kept' AND (SELECT v FROM t18 WHERE k = 'after') = 'unassigned'
  AND (SELECT v FROM t18 WHERE k = 'invite') = '0' AND (SELECT v FROM t18 WHERE k = 'seats') = '3',
  (SELECT string_agg(k || '=' || v, ' ' ORDER BY k) FROM t18));
