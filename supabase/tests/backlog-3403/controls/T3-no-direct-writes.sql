-- T3: agent cannot INSERT, UPDATE, DELETE or TRUNCATE submission_attempts directly
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT public.record_submission_attempt(:'S', :'ORG', 'in_progress', NULL, NULL, 0, '{}', false, NULL, NULL);
DO $$ BEGIN
  INSERT INTO public.submission_attempts (submission_id, user_id, organization_id) VALUES (gen_random_uuid(), 'aaaaaaaa-3403-4000-8000-000000000001', '0e340300-0000-4000-8000-0000000000a1');  -- pii-allow-uuid: invented fixture id
  RAISE EXCEPTION 'T3 insert was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'T3 insert refused'); END $$;
DO $$ BEGIN
  UPDATE public.submission_attempts SET outcome = 'committed';
  RAISE EXCEPTION 'T3 update was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'T3 update refused'); END $$;
DO $$ BEGIN
  DELETE FROM public.submission_attempts;
  RAISE EXCEPTION 'T3 delete was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'T3 delete refused'); END $$;
DO $$ BEGIN
  TRUNCATE public.submission_attempts;
  RAISE EXCEPTION 'T3 truncate was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'T3 truncate refused'); END $$;
