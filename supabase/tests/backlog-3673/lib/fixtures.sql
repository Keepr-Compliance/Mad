-- BACKLOG-3673 fixtures. Runs inside the harness transaction, as postgres,
-- BEFORE the migration. Synthetic ids and addresses only.
--   u_pending: email step answered, record empty  -> in the backfill set
--   u_fresh:   both empty                         -> untouched by the backfill
--   u_set:     record already set, to a value different from the email answer
INSERT INTO auth.users (id, email, aud, role) VALUES
 (pg_temp.id('u_pending'), 'pending-3673@example.test', 'authenticated', 'authenticated'),
 (pg_temp.id('u_fresh'),   'fresh-3673@example.test',   'authenticated', 'authenticated'),
 (pg_temp.id('u_set'),     'set-3673@example.test',     'authenticated', 'authenticated');
INSERT INTO public.users (id, email, oauth_provider, oauth_id,
                          email_onboarding_completed_at, onboarding_completed_at) VALUES
 (pg_temp.id('u_pending'), 'pending-3673@example.test', 'google', 'pending3673',
  '2026-09-01T10:00:00Z', NULL),
 (pg_temp.id('u_fresh'),   'fresh-3673@example.test',   'google', 'fresh3673',
  NULL, NULL),
 (pg_temp.id('u_set'),     'set-3673@example.test',     'google', 'set3673',
  '2026-09-02T10:00:00Z', '2026-09-20T10:00:00Z');

-- The pre-check, exactly as the apply packet runs it: the ids the backfill
-- will touch. The rollback is keyed on this list.
CREATE TEMP TABLE t3673_pre ON COMMIT DROP AS
  SELECT id FROM public.users
   WHERE email_onboarding_completed_at IS NOT NULL
     AND onboarding_completed_at IS NULL;

-- Every row's record and email answer before the migration.
CREATE TEMP TABLE t3673_before ON COMMIT DROP AS
  SELECT id, onboarding_completed_at AS rec, email_onboarding_completed_at AS email
    FROM public.users;
