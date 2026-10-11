-- Runs after the migration (skipped by the baseline run, which has no is_test).
-- The is_test flag is a server-side data step; set it as postgres.
DO $p$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                AND table_name = 'organizations' AND column_name = 'is_test') THEN
    EXECUTE format('UPDATE public.organizations SET is_test = true WHERE id IN (%L::uuid, %L::uuid)',
                   pg_temp.porg('u_test'), pg_temp.id('x_org'));
  END IF;
END $p$;
