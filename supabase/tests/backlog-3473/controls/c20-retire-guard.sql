-- harness: without-file3
-- C20: migration 3 drops nothing while any organization holds a non-default
-- value in the three columns. run.sh loads everything EXCEPT migration 3 for
-- this control and puts migration 3's text in :mig3_sql; pg_temp.try_exec runs
-- the whole text as one unit, rolled back on error, as a failed migration.
-- For each column, T1 holds the non-default value:
--   require_dual_approval = true      : P0001 'retire_unused_org_columns: ...'; 3 columns remain
--   auto_reject_incomplete = true     : same
--   minimum_attachment_types = '{}'   : same (non-NULL)
-- Every value back at its default                                  : ok; 0 columns remain
-- Mutant: f01 (migration 3 without its guard block).

SELECT pg_temp.act_owner();
CREATE FUNCTION pg_temp.c20_cols() RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organizations'
     AND column_name IN ('require_dual_approval', 'auto_reject_incomplete', 'minimum_attachment_types')
$$;
SELECT pg_temp.check(pg_temp.c20_cols() = 3, 'the three columns exist before migration 3');

UPDATE public.organizations SET require_dual_approval = true WHERE id = pg_temp.id('o_t1');
SELECT set_config('t3473.c20_1', pg_temp.try_exec(:'mig3_sql'), true);
UPDATE public.organizations SET require_dual_approval = false WHERE id = pg_temp.id('o_t1');

UPDATE public.organizations SET auto_reject_incomplete = true WHERE id = pg_temp.id('o_t1');
SELECT set_config('t3473.c20_2', pg_temp.try_exec(:'mig3_sql'), true);
UPDATE public.organizations SET auto_reject_incomplete = false WHERE id = pg_temp.id('o_t1');

UPDATE public.organizations SET minimum_attachment_types = '{}' WHERE id = pg_temp.id('o_t1');
SELECT set_config('t3473.c20_3', pg_temp.try_exec(:'mig3_sql'), true);
UPDATE public.organizations SET minimum_attachment_types = NULL WHERE id = pg_temp.id('o_t1');

DO $c20$
DECLARE
  k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['c20_1', 'c20_2', 'c20_3'] LOOP
    PERFORM pg_temp.check(current_setting('t3473.' || k) LIKE 'P0001:retire_unused_org_columns:%',
                          format('%s: migration 3 raises its guard, got %s', k, current_setting('t3473.' || k)));
  END LOOP;
  PERFORM pg_temp.check(pg_temp.c20_cols() = 3, 'the three columns still exist after the refused runs');
END
$c20$;

SELECT set_config('t3473.c20_ok', pg_temp.try_exec(:'mig3_sql'), true);
DO $c20ok$
BEGIN
  PERFORM pg_temp.check(current_setting('t3473.c20_ok') = 'ok',
                        format('defaults everywhere: migration 3 runs, got %s', current_setting('t3473.c20_ok')));
  PERFORM pg_temp.check(pg_temp.c20_cols() = 0, 'the three columns are dropped');
END
$c20ok$;
