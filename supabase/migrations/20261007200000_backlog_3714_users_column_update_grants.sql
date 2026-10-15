-- BACKLOG-3714: client UPDATE on public.users is limited to a named column list.
--
-- Version 20261007200000 claimed in the tracker before this file was written.
-- Apply as ONE transaction (`psql -1 -f <file>`, or the whole file in one SQL
-- editor run). It opens none of its own. Both statements are safe to run twice.
--
--   1. The table-level UPDATE privilege is removed from PUBLIC, anon and
--      authenticated. (A column-level REVOKE alone would change nothing while
--      the table-level grant stands.)
--
--   2. UPDATE is granted back to authenticated on 16 columns only: the ones
--      the desktop app and the broker portal write with a user session
--      (profile sync on sign-in, terms acceptance, the email onboarding step,
--      the setup-finished record, and the invite-link upsert). The other 23
--      columns of the table are not client-writable. anon gets no UPDATE.
--
-- NOT changed: INSERT, SELECT and DELETE privileges; every RLS policy on
-- public.users; triggers; service_role (it keeps its own table-level grant);
-- SECURITY DEFINER functions owned by postgres.
--
-- Maintenance notes:
--   * A column added to public.users later is NOT client-writable unless a
--     migration grants UPDATE on it to authenticated by name.
--   * Any future `GRANT ... ON ALL TABLES IN SCHEMA public TO authenticated`
--     (or a table-level GRANT UPDATE on public.users) would widen client write
--     access on this table again, with no error anywhere. After any such
--     change, re-check: has_column_privilege(..., 'UPDATE') on public.users
--     must be true for exactly 16 columns for authenticated, 0 for anon,
--     all columns for service_role.
--
-- Rollback is posted with the apply packet on the backlog item, not kept here.

REVOKE UPDATE ON TABLE public.users FROM PUBLIC, anon, authenticated;

GRANT UPDATE (
  id,
  email,
  first_name,
  last_name,
  display_name,
  avatar_url,
  last_login_at,
  updated_at,
  terms_accepted_at,
  terms_version_accepted,
  privacy_policy_accepted_at,
  privacy_policy_version_accepted,
  email_onboarding_completed_at,
  onboarding_completed_at,
  oauth_provider,
  oauth_id
) ON public.users TO authenticated;
