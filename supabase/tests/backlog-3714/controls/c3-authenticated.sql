-- As `authenticated` on the own row (request.jwt.claims sub = u_self).
--
-- Statement sources:
--   login sync (electron/services/supabaseService.ts:792), terms (:993) and
--   email onboarding (:1026): TRANSCRIBED from prod pg_stat_statements
--   (role authenticated, 2026-10-07). Parameters filled with synthetic values.
--   setup finished (:1093) and the broker invite upsert
--   (broker-portal/app/auth/callback/route.ts:110-120): CAPTURED from the SQL
--   PostgREST v14.5 sent for the same supabase-js 2.110.2 call (Postgres
--   log_statement=all, local stack, 2026-10-07).
-- The invite upsert is RECONSTRUCTED as far as prod is concerned: prod's
-- PostgREST version is not established and pg_stat_statements holds no upsert
-- shape. It runs on the conflict path (row already exists), the only path
-- prod takes (handle_new_user creates the row at signup).
-- In the four UPDATE shapes, PostgREST's outer response projection (an
-- aggregate, always one row) is replaced by `SELECT * FROM pgrst_source`, so
-- the row count is the number of rows written. The upsert is kept verbatim
-- and checked on the stored value instead.
DO $$ DECLARE m text; before jsonb; BEGIN
  -- login sync (:792), RETURNING "public"."users".* as transcribed
  m := pg_temp.as_role('authenticated', pg_temp.id('u_self'), $q$WITH pgrst_source AS (UPDATE "public"."users" SET "display_name" = "pgrst_body"."display_name", "email" = "pgrst_body"."email", "first_name" = "pgrst_body"."first_name", "last_login_at" = "pgrst_body"."last_login_at", "last_name" = "pgrst_body"."last_name", "updated_at" = "pgrst_body"."updated_at" FROM (SELECT '{"display_name":"x3714 sync","email":"self-3714@example.test","first_name":"x3714a","last_login_at":"2026-10-07T10:00:00Z","last_name":"x3714b","updated_at":"2026-10-07T10:00:00Z"}'::json AS json_data) pgrst_payload, LATERAL (SELECT "display_name", "email", "first_name", "last_login_at", "last_name", "updated_at" FROM json_to_record(pgrst_payload.json_data) AS _("display_name" text, "email" text, "first_name" text, "last_login_at" timestamp with time zone, "last_name" text, "updated_at" timestamp with time zone) ) pgrst_body  WHERE  "public"."users"."id" = '{u_self}' RETURNING "public"."users".*) SELECT * FROM pgrst_source$q$);
  PERFORM pg_temp.check('c3 authenticated: login sync statement (:792) writes 1 row', m = 'OK rows=1', m);

  -- terms (:993), RETURNING "public"."users".* as transcribed
  m := pg_temp.as_role('authenticated', pg_temp.id('u_self'), $q$WITH pgrst_source AS (UPDATE "public"."users" SET "privacy_policy_accepted_at" = "pgrst_body"."privacy_policy_accepted_at", "privacy_policy_version_accepted" = "pgrst_body"."privacy_policy_version_accepted", "terms_accepted_at" = "pgrst_body"."terms_accepted_at", "terms_version_accepted" = "pgrst_body"."terms_version_accepted", "updated_at" = "pgrst_body"."updated_at" FROM (SELECT '{"privacy_policy_accepted_at":"2026-10-07T10:00:00Z","privacy_policy_version_accepted":"1.0","terms_accepted_at":"2026-10-07T10:00:00Z","terms_version_accepted":"1.0","updated_at":"2026-10-07T10:00:00Z"}'::json AS json_data) pgrst_payload, LATERAL (SELECT "privacy_policy_accepted_at", "privacy_policy_version_accepted", "terms_accepted_at", "terms_version_accepted", "updated_at" FROM json_to_record(pgrst_payload.json_data) AS _("privacy_policy_accepted_at" timestamp with time zone, "privacy_policy_version_accepted" text, "terms_accepted_at" timestamp with time zone, "terms_version_accepted" text, "updated_at" timestamp with time zone) ) pgrst_body  WHERE  "public"."users"."id" = '{u_self}' RETURNING "public"."users".*) SELECT * FROM pgrst_source$q$);
  PERFORM pg_temp.check('c3 authenticated: terms statement (:993) writes 1 row', m = 'OK rows=1', m);

  -- email onboarding (:1026), RETURNING $3 (a constant) as transcribed
  m := pg_temp.as_role('authenticated', pg_temp.id('u_self'), $q$WITH pgrst_source AS (UPDATE "public"."users" SET "email_onboarding_completed_at" = "pgrst_body"."email_onboarding_completed_at", "updated_at" = "pgrst_body"."updated_at" FROM (SELECT '{"email_onboarding_completed_at":"2026-10-07T10:00:00Z","updated_at":"2026-10-07T10:00:00Z"}'::json AS json_data) pgrst_payload, LATERAL (SELECT "email_onboarding_completed_at", "updated_at" FROM json_to_record(pgrst_payload.json_data) AS _("email_onboarding_completed_at" timestamp with time zone, "updated_at" timestamp with time zone) ) pgrst_body  WHERE  "public"."users"."id" = '{u_self}' RETURNING 1) SELECT * FROM pgrst_source$q$);
  PERFORM pg_temp.check('c3 authenticated: email onboarding statement (:1026) writes 1 row', m = 'OK rows=1', m);

  -- setup finished (:1093), RETURNING "public"."users"."id" as captured
  m := pg_temp.as_role('authenticated', pg_temp.id('u_self'), $q$WITH pgrst_source AS (UPDATE "public"."users" SET "onboarding_completed_at" = "pgrst_body"."onboarding_completed_at" FROM (SELECT '{"onboarding_completed_at":"2026-10-07T10:00:00Z"}'::json AS json_data) pgrst_payload, LATERAL (SELECT "onboarding_completed_at" FROM json_to_record(pgrst_payload.json_data) AS _("onboarding_completed_at" timestamp with time zone) ) pgrst_body  WHERE  "public"."users"."id" = '{u_self}' AND  "public"."users"."onboarding_completed_at" IS NULL RETURNING "public"."users"."id") SELECT * FROM pgrst_source$q$);
  PERFORM pg_temp.check('c3 authenticated: setup-finished statement (:1093) writes 1 row', m = 'OK rows=1', m);

  -- broker invite upsert, RECONSTRUCTED (see header), conflict path, kept
  PERFORM pg_temp.check('c3 authenticated: invite upsert precondition: own row exists',
    pg_temp.snap('u_self') IS NOT NULL);
  m := pg_temp.as_role('authenticated', pg_temp.id('u_self'), $q$WITH pgrst_source AS (INSERT INTO "public"."users"("display_name", "email", "first_name", "id", "last_name", "oauth_id", "oauth_provider") SELECT "pgrst_body"."display_name", "pgrst_body"."email", "pgrst_body"."first_name", "pgrst_body"."id", "pgrst_body"."last_name", "pgrst_body"."oauth_id", "pgrst_body"."oauth_provider" FROM (SELECT '{"display_name":"x3714 invite","email":"self-3714@example.test","first_name":"x3714c","id":"{u_self}","last_name":"x3714d","oauth_id":"self3714","oauth_provider":"google"}'::json AS json_data) pgrst_payload, LATERAL (SELECT "display_name", "email", "first_name", "id", "last_name", "oauth_id", "oauth_provider" FROM json_to_record(pgrst_payload.json_data) AS _("display_name" text, "email" text, "first_name" text, "id" uuid, "last_name" text, "oauth_id" text, "oauth_provider" text) ) pgrst_body WHERE set_config('pgrst.inserted', (coalesce(nullif(current_setting('pgrst.inserted', true), '')::int, 0) + 1)::text, true) <> '0' ON CONFLICT("id") DO UPDATE SET "display_name" = EXCLUDED."display_name", "email" = EXCLUDED."email", "first_name" = EXCLUDED."first_name", "id" = EXCLUDED."id", "last_name" = EXCLUDED."last_name", "oauth_id" = EXCLUDED."oauth_id", "oauth_provider" = EXCLUDED."oauth_provider"WHERE set_config('pgrst.inserted', (coalesce(nullif(current_setting('pgrst.inserted', true), '')::int, 0) - 1)::text, true) <> '-1' RETURNING 1) SELECT '' AS total_result_set, pg_catalog.count(_postgrest_t) AS page_total, array[]::text[] AS header, ''::text AS body, nullif(current_setting('response.headers', true), '') AS response_headers, nullif(current_setting('response.status', true), '') AS response_status, nullif(current_setting('pgrst.inserted', true),'')::int AS response_inserted FROM (SELECT * FROM pgrst_source) _postgrest_t$q$, true);
  PERFORM pg_temp.check('c3 authenticated: invite upsert (conflict path) succeeds and stores display_name',
    m LIKE 'OK %' AND pg_temp.snap('u_self')->>'display_name' = 'x3714 invite',
    m || ' display_name=' || coalesce(pg_temp.snap('u_self')->>'display_name', '<null>'));

  -- every locked column: 42501 and the stored row unchanged
  PERFORM pg_temp.sweep('c3 authenticated sweep', 'authenticated', pg_temp.id('u_self'));

  -- a kept column and a locked column in one statement: refused as a whole
  before := pg_temp.snap('u_self');
  m := pg_temp.as_role('authenticated', pg_temp.id('u_self'),
    'update public.users set email = ''mixed-3714@example.test'', subscription_tier = ''enterprise'' where id = ''{u_self}''', true);
  PERFORM pg_temp.check('c3 authenticated: email + subscription_tier in one statement refused with 42501, row unchanged',
    m LIKE 'ERR 42501 %' AND pg_temp.snap('u_self') = before, m);

  -- the owner policy still scopes a kept column to the own row
  before := pg_temp.snap('u_other');
  m := pg_temp.as_role('authenticated', pg_temp.id('u_self'),
    'update public.users set display_name = ''x3714'' where id = ''{u_other}''', true);
  PERFORM pg_temp.check('c3 authenticated: another user''s row updates 0 rows',
    m = 'OK rows=0' AND pg_temp.snap('u_other') = before, m);
END $$;
