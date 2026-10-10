-- Rollback for 20261010210000_backlog_3858_personal_orgs_for_licensed_users.sql.
--
-- Removes exactly the organizations recorded in
-- public.backlog_3858_personal_org_backfill (ON DELETE CASCADE removes their
-- organization_members, organization_plans and checklist_templates rows), then
-- drops that table. Personal organizations created any other way (desktop
-- sign-in) are not touched.
--
-- Refuses, writing nothing, when a recorded organization
--   * is no longer the personal organization of the recorded user,
--   * holds a membership for anyone else, or
--   * has non-empty feature_overrides on its plan row (a grant made after the
--     backfill would be lost).
-- Rows in tables that reference organizations without CASCADE (profiles,
-- support_tickets) make the DELETE itself fail.

BEGIN;

DO $r3858$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('public.backlog_3858_personal_org_backfill') IS NULL THEN
    RAISE NOTICE 'BACKLOG-3858 rollback: bookkeeping table absent; nothing to do';
    RETURN;
  END IF;

  SELECT string_agg(b.organization_id::text || ':' || x.reason, ', ') INTO v_bad
    FROM public.backlog_3858_personal_org_backfill b
    CROSS JOIN LATERAL (
      SELECT 'not personal org of recorded user' AS reason
       WHERE NOT EXISTS (SELECT 1 FROM public.organizations o
                          WHERE o.id = b.organization_id AND o.personal_owner_user_id = b.user_id)
      UNION ALL
      SELECT 'other member'
       WHERE EXISTS (SELECT 1 FROM public.organization_members m
                      WHERE m.organization_id = b.organization_id AND m.user_id IS DISTINCT FROM b.user_id)
      UNION ALL
      SELECT 'feature_overrides set'
       WHERE EXISTS (SELECT 1 FROM public.organization_plans op
                      WHERE op.organization_id = b.organization_id
                        AND COALESCE(op.feature_overrides, '{}'::jsonb) <> '{}'::jsonb)
    ) x;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'BACKLOG-3858 rollback refused: %', v_bad;
  END IF;

  DELETE FROM public.organizations o
   USING public.backlog_3858_personal_org_backfill b
   WHERE o.id = b.organization_id
     AND o.personal_owner_user_id = b.user_id;

  DROP TABLE public.backlog_3858_personal_org_backfill;
END
$r3858$;

COMMIT;
