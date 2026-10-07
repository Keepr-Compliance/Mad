-- 3673's write-once guard still works with 3714 applied: the setup-finished
-- statement (:1093, captured; see c3) stores the value on an empty row; a
-- later clear or move keeps it; the same statement on a set row writes 0 rows.
DO $$ DECLARE m text; v text; BEGIN
  m := pg_temp.as_role('authenticated', pg_temp.id('u_self'), $q$WITH pgrst_source AS (UPDATE "public"."users" SET "onboarding_completed_at" = "pgrst_body"."onboarding_completed_at" FROM (SELECT '{"onboarding_completed_at":"2026-10-07T10:00:00Z"}'::json AS json_data) pgrst_payload, LATERAL (SELECT "onboarding_completed_at" FROM json_to_record(pgrst_payload.json_data) AS _("onboarding_completed_at" timestamp with time zone) ) pgrst_body  WHERE  "public"."users"."id" = '{u_self}' AND  "public"."users"."onboarding_completed_at" IS NULL RETURNING "public"."users"."id") SELECT * FROM pgrst_source$q$, true);
  v := pg_temp.snap('u_self')->>'onboarding_completed_at';
  PERFORM pg_temp.check('c5 3673: setup-finished statement on an empty row stores the value',
    m = 'OK rows=1' AND v IS NOT NULL, m || ' value=' || coalesce(v, '<null>'));
  m := pg_temp.as_role('authenticated', pg_temp.id('u_self'),
    'update public.users set onboarding_completed_at = null where id = ''{u_self}''', true);
  PERFORM pg_temp.check('c5 3673: ts -> null keeps the value',
    pg_temp.snap('u_self')->>'onboarding_completed_at' IS NOT DISTINCT FROM v AND v IS NOT NULL, m);
  m := pg_temp.as_role('authenticated', pg_temp.id('u_self'),
    'update public.users set onboarding_completed_at = ''2001-01-01T00:00:00Z'' where id = ''{u_self}''', true);
  PERFORM pg_temp.check('c5 3673: ts -> other ts keeps the value',
    pg_temp.snap('u_self')->>'onboarding_completed_at' IS NOT DISTINCT FROM v AND v IS NOT NULL, m);
  m := pg_temp.as_role('authenticated', pg_temp.id('u_self'), $q$WITH pgrst_source AS (UPDATE "public"."users" SET "onboarding_completed_at" = "pgrst_body"."onboarding_completed_at" FROM (SELECT '{"onboarding_completed_at":"2026-10-08T10:00:00Z"}'::json AS json_data) pgrst_payload, LATERAL (SELECT "onboarding_completed_at" FROM json_to_record(pgrst_payload.json_data) AS _("onboarding_completed_at" timestamp with time zone) ) pgrst_body  WHERE  "public"."users"."id" = '{u_self}' AND  "public"."users"."onboarding_completed_at" IS NULL RETURNING "public"."users"."id") SELECT * FROM pgrst_source$q$);
  PERFORM pg_temp.check('c5 3673: setup-finished statement on a set row writes 0 rows', m = 'OK rows=0', m);
END $$;
