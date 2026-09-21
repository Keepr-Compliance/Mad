-- BACKLOG-3473: take migrations 1 and 2 back OFF a test venue after the
-- committed PostgREST probe (run.sh apply). For the venue only -- never
-- production.
--
-- 1. Refuses when migration 3 has been applied here (its three dropped
--    columns cannot be restored with their data), and when any of the seven
--    new tables still holds rows (run probe-cleanup first; nothing here may
--    erase rows it did not create).
-- 2. Drops the two triggers on organization_plans, restores the three read
--    functions VERBATIM from lib/rpc-before.sql, drops the seven tables and
--    the six new functions, the transaction_checklists feature and plan rows,
--    submission_attachments.local_attachment_id, and the two history rows.
-- 3. Re-hashes the three read functions and raises (rolling everything back)
--    unless each equals production's md5(pg_get_functiondef) from 2026-09-21.
-- Afterwards run.sh gate must re-match.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $refuse$
DECLARE
  t text;
  n bigint;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organizations'
         AND column_name IN ('require_dual_approval', 'auto_reject_incomplete', 'minimum_attachment_types')) <> 3 THEN
    RAISE EXCEPTION 'teardown refused: migration 3 has been applied on this venue; its columns cannot be restored';
  END IF;
  FOREACH t IN ARRAY ARRAY['public.submission_checklist_link_members', 'public.submission_checklist_links',
                           'public.submission_checklist_items', 'public.submission_checklists',
                           'public.checklist_template_items', 'public.checklist_templates',
                           'public.checklist_seed_templates'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %s', t) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION 'teardown refused: % holds % row(s); run probe-cleanup first', t, n;
      END IF;
    END IF;
  END LOOP;
END
$refuse$;

DROP TRIGGER IF EXISTS reject_feature_override_above_tier ON public.organization_plans;
DROP TRIGGER IF EXISTS seed_checklists_on_plan_write ON public.organization_plans;

\ir rpc-before.sql

DROP TABLE IF EXISTS public.submission_checklist_link_members;
DROP TABLE IF EXISTS public.submission_checklist_links;
DROP TABLE IF EXISTS public.submission_checklist_items;
DROP TABLE IF EXISTS public.submission_checklists;
DROP TABLE IF EXISTS public.checklist_template_items;
DROP TABLE IF EXISTS public.checklist_templates;
DROP TABLE IF EXISTS public.checklist_seed_templates;

DROP FUNCTION IF EXISTS public._reject_feature_override_above_tier();
DROP FUNCTION IF EXISTS public._override_above_tier(text, text, text, jsonb);
DROP FUNCTION IF EXISTS public._seed_checklists_on_plan_write();
DROP FUNCTION IF EXISTS public._seed_org_checklist_templates(uuid);
DROP FUNCTION IF EXISTS public.can_edit_checklist_templates(uuid);
DROP FUNCTION IF EXISTS public._checklist_seed_items_valid(jsonb);

DELETE FROM public.plan_features
 WHERE feature_id IN (SELECT id FROM public.feature_definitions WHERE key = 'transaction_checklists');
DELETE FROM public.feature_definitions WHERE key = 'transaction_checklists';

ALTER TABLE public.submission_attachments DROP COLUMN IF EXISTS local_attachment_id;

DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('20260921101756', '20260921101757');

DO $verify$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.check_feature_access(uuid,text)', '864e0a56a064a02fefb0c6acc707990f'),
    ('public.get_org_features(uuid)',          'be09560411aa508b869a523d35931211'),
    ('public.broker_get_org_features(uuid)',   '60c63f216f5a10ab804e90f74d7d8284')
  ) v(sig, pin) LOOP
    IF md5(pg_get_functiondef(to_regprocedure(r.sig))) IS DISTINCT FROM r.pin THEN
      RAISE EXCEPTION 'teardown: % restored as %, expected production %',
        r.sig, md5(pg_get_functiondef(to_regprocedure(r.sig))), r.pin;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organization_plans'::regclass
              AND tgname IN ('reject_feature_override_above_tier', 'seed_checklists_on_plan_write')) THEN
    RAISE EXCEPTION 'teardown: a BACKLOG-3473 trigger is still on organization_plans';
  END IF;
  RAISE NOTICE 'teardown verified: the three read functions hash to production''s bodies';
END
$verify$;

COMMIT;
