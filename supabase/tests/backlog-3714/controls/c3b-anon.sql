-- As `anon` (no sub). The terms statement as transcribed for role anon from
-- prod pg_stat_statements, and every locked column: each refused with 42501
-- (not a 0-row result) and u_self's stored row unchanged.
DO $$ DECLARE m text; before jsonb; BEGIN
  before := pg_temp.snap('u_self');
  m := pg_temp.as_role('anon', NULL, $q$WITH pgrst_source AS (UPDATE "public"."users" SET "privacy_policy_accepted_at" = "pgrst_body"."privacy_policy_accepted_at", "privacy_policy_version_accepted" = "pgrst_body"."privacy_policy_version_accepted", "terms_accepted_at" = "pgrst_body"."terms_accepted_at", "terms_version_accepted" = "pgrst_body"."terms_version_accepted", "updated_at" = "pgrst_body"."updated_at" FROM (SELECT '{"privacy_policy_accepted_at":"2026-10-07T10:00:00Z","privacy_policy_version_accepted":"1.0","terms_accepted_at":"2026-10-07T10:00:00Z","terms_version_accepted":"1.0","updated_at":"2026-10-07T10:00:00Z"}'::json AS json_data) pgrst_payload, LATERAL (SELECT "privacy_policy_accepted_at", "privacy_policy_version_accepted", "terms_accepted_at", "terms_version_accepted", "updated_at" FROM json_to_record(pgrst_payload.json_data) AS _("privacy_policy_accepted_at" timestamp with time zone, "privacy_policy_version_accepted" text, "terms_accepted_at" timestamp with time zone, "terms_version_accepted" text, "updated_at" timestamp with time zone) ) pgrst_body  WHERE  "public"."users"."id" = '{u_self}' RETURNING "public"."users".*) SELECT * FROM pgrst_source$q$, true);
  PERFORM pg_temp.check('c3b anon: terms statement refused with 42501, row unchanged',
    m LIKE 'ERR 42501 %' AND pg_temp.snap('u_self') = before, m);
  PERFORM pg_temp.sweep('c3b anon sweep', 'anon', NULL);
END $$;
