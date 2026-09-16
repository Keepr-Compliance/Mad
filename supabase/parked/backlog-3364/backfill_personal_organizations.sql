-- BACKLOG-3364 backfill: PARKED. NOT A MIGRATION. DO NOT RUN. See README.md.
--
-- Gives every licensed user who holds no organization membership a personal
-- organization, by calling public._ensure_personal_organization_for (created by
-- supabase/migrations/20260915160637_backlog_3364_personal_organizations.sql).
--
-- Skips any user with an UNCLAIMED invite row for their email, expired or not,
-- and reports how many it skipped.
--
-- One statement (a single DO block), so it is atomic on its own and can be run
-- inside a test transaction. Re-running it writes nothing: a user who already
-- holds a personal membership is no longer in the cohort.

DO $backfill$
DECLARE
  r              record;
  v              jsonb;
  n_cohort       integer := 0;
  n_skip_invite  integer := 0;
  n_created      integer := 0;
  n_attached     integer := 0;
  n_other        integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  FOR r IN
    SELECT l.user_id,
           COALESCE(
             NULLIF(TRIM(au.email), ''),
             NULLIF(TRIM(au.raw_user_meta_data->>'email'), ''),
             au.raw_user_meta_data->>'mail',
             au.raw_user_meta_data->>'preferred_username'
           ) AS email
    FROM public.licenses l
    JOIN auth.users au ON au.id = l.user_id
    WHERE NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = l.user_id)
    ORDER BY l.user_id
  LOOP
    n_cohort := n_cohort + 1;

    IF r.email IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.organization_members
      WHERE user_id IS NULL
        AND LOWER(TRIM(invited_email)) = LOWER(TRIM(r.email))
    ) THEN
      n_skip_invite := n_skip_invite + 1;
      CONTINUE;
    END IF;

    v := public._ensure_personal_organization_for(r.user_id);
    CASE v->>'status'
      WHEN 'created'  THEN n_created  := n_created + 1;
      WHEN 'attached' THEN n_attached := n_attached + 1;
      ELSE n_other := n_other + 1;
    END CASE;
  END LOOP;

  RAISE NOTICE 'backlog-3364 backfill: cohort=%, skipped_unclaimed_invite=%, created=%, attached=%, other=%',
    n_cohort, n_skip_invite, n_created, n_attached, n_other;
END
$backfill$;
