-- BACKLOG-3851: the venue must equal PRODUCTION TODAY (read 2026-10-14 via Supabase MCP,
-- ledger head 20261014152904) for every object lib/fingerprint-3851.sql reads, else ERROR.
-- Unlike the 3917/3946 pins this is a current production read: re-run fingerprint-3851.sql
-- on production immediately before applying M1; any row that differs from this list = STOP.
-- run.sh defines pg_temp.venue3851() from fingerprint-3851.sql (same query text).
CREATE TEMP TABLE t3851_prod (k text PRIMARY KEY, v text) ON COMMIT DROP;
INSERT INTO t3851_prod (k, v) VALUES
  ('cols organization_members', '32f545c0360ec33b8e3555d831bcabab'),
  ('cols organizations', 'c193cc73f168cf8b3542444b537c9261'),
  ('con organization_members_invitation_token_key', 'bd859f6b53564282feac2f0e7fee1056'),
  ('con organization_members_invited_by_fkey', 'ec8bea94f39fae677581fcfd9b20c4c9'),
  ('con organization_members_license_status_check', '554e8c6407582c814514dd159038b296'),
  ('con organization_members_organization_id_fkey', '3c702b28ccc97a0ac52c0acefcdea477'),
  ('con organization_members_organization_id_user_id_key', '0522fd08870e800988ad0017c5465df8'),
  ('con organization_members_pkey', '4c6419b3704337bbfe50f018842a9ad3'),
  ('con organization_members_provisioned_by_check', '810b8cfd4f600c778e4589adc360c616'),
  ('con organization_members_role_check', '1001427b5b028f4c0c37b09d3e5deb80'),
  ('con organization_members_user_id_fkey', '85d8b2f5f0c0f6b4dcb854efb61a8cb1'),
  ('con organization_members_user_id_public_users_fkey', 'e208476b0e6d80576b69508e9d165e3f'),
  ('fn _ensure_personal_organization_for(uuid)', '849314911f1e4622096bd0102723f793'),
  ('fn _guard_personal_owner_user_id()', 'fa0dc8d6dc997822053021b15b3b05ea'),
  ('fn _retire_personal_membership()', '26f5fb802a0e8e8b217f0e33bf2490ee'),
  ('fn admin_invite_user(uuid,text,text,uuid,text,uuid)', 'f760693925ff2a08a2595b19f27ed1cd'),
  ('fn auto_provision_google_it_admin(text,text,text)', '5e88920962967b861c5817aec328325e'),
  ('fn auto_provision_it_admin(text,text,text)', '11d8619f8dc65e22f53e668e8eade957'),
  ('fn broker_get_org_features(uuid)', 'ea48082497e2d44ed912caf2cd71d011'),
  ('fn check_feature_access(uuid,text)', 'b271dd9bf2187d58c425806276180b1f'),
  ('fn claim_pending_invite()', 'f5a006ac110f1f6d817e0b01b9da12ea'),
  ('fn ensure_personal_organization()', '1f722dc8b511a40cc9e78f271b1d78a6'),
  ('fn get_org_features(uuid)', '37520ebbb0377d92d9fa0c0fc7e0231a'),
  ('fn guard_invite_acceptance()', 'afde3e325917d53bf78a0fda2ca2d84e'),
  ('fn guard_organization_client_update()', '8c931ae0c7674fd65a51720d7f2376ac'),
  ('fn jit_join_organization(text)', '6b0f4c93bbd7671e916c05e214c40a5b'),
  ('fn member_status_grants_access(text)', 'd407b02e2aa222e9af003f66506e2480'),
  ('fn update_updated_at_column()', '9e2677705d54938c11504cf340bae4e4'),
  ('trg organization_members.guard_invite_acceptance', '8b4b45054ed050e29fb1a4bc20932603'),
  ('trg organization_members.retire_personal_membership', '7114babde1c6464af54438a0824765d5'),
  ('trg organization_members.update_org_members_updated_at', '7f7cbe08356763dcf9c0110a2a20d150'),
  ('trg organizations.guard_organization_client_update', 'fe0492e0373d142a59a0f582aeaa1ddc'),
  ('trg organizations.guard_personal_owner_user_id', '817c707b844bba42b3fea695e44247c2'),
  ('trg organizations.update_organizations_updated_at', '18d1ba39339173ebb60ab85e8f9af0dd');
DO $pin$ DECLARE bad text; BEGIN
  SELECT string_agg(coalesce(p.k, v.k)||' prod='||coalesce(p.v,'<none>')||' venue='||coalesce(v.v,'<none>'), E'\n') INTO bad
    FROM t3851_prod p FULL JOIN pg_temp.venue3851() v ON v.k = p.k WHERE p.v IS DISTINCT FROM v.v;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'PINS3851 MISMATCH:%', E'\n'||bad; END IF;
END $pin$;
SELECT 'PINS3851 OK';
