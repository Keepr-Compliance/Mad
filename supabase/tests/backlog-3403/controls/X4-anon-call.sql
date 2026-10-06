-- X4: anon calling finalize: permission denied
SET LOCAL ROLE anon;
DO $$ BEGIN
  PERFORM public.finalize_submission('5b340300-0000-4000-8000-000000000001', '{}'::jsonb);  -- pii-allow-uuid: invented fixture id
  RAISE EXCEPTION 'X4 was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'X4 refused'); END $$;
