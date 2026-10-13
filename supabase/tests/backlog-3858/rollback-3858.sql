-- Rollback for the migration ending in _backlog_3858_personal_orgs_for_licensed_users.sql.
--
-- Removes exactly the organizations recorded in
-- public.backlog_3858_personal_org_backfill, then drops that table. Personal
-- organizations created any other way (desktop sign-in) are not touched.
--
-- Deleting an organization cascades. Every table with a foreign key to
-- public.organizations is listed below (catalog: pg_constraint, confrelid =
-- public.organizations; same set on the venue and on production):
--   ON DELETE CASCADE  checklist_templates (-> checklist_template_items, cascade),
--                      organization_identity_providers, organization_members,
--                      organization_plans, scim_sync_log, scim_tokens,
--                      submission_attempts, transaction_submissions
--   NO ACTION          profiles, support_tickets
-- The migration creates only: the organization, its owner's membership, its
-- plan row and the checklist templates/items seeded from checklist_seed_templates.
--
-- The rollback REFUSES (raises, deletes nothing) when a recorded organization
--   * is no longer the personal organization of the recorded user,
--   * holds a membership for anyone else,
--   * has non-empty feature_overrides on its plan row,
--   * has any row in ANY other table with a foreign key to organizations
--     (found from pg_constraint at run time, so a table added later is covered),
--   * has a checklist template that is not an untouched seeded one (no seed_key,
--     created_by / updated_by / owner_user_id set, archived, or updated after
--     it was seeded), or a checklist item changed or added after seeding.

BEGIN;

DO $r3858$
DECLARE
  v_bad text;
  v_fk record;
  v_n bigint;
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
      UNION ALL
      SELECT 'checklist template not an untouched seeded one'
       WHERE EXISTS (SELECT 1 FROM public.checklist_templates t
                      WHERE t.organization_id = b.organization_id
                        AND (t.seed_key IS NULL OR t.seeded_at IS NULL
                             OR t.created_by IS NOT NULL OR t.updated_by IS NOT NULL
                             OR t.owner_user_id IS NOT NULL OR t.archived_at IS NOT NULL
                             OR t.updated_at > t.seeded_at))
      UNION ALL
      SELECT 'checklist item changed or added after seeding'
       WHERE EXISTS (SELECT 1 FROM public.checklist_template_items i
                       JOIN public.checklist_templates t ON t.id = i.template_id
                      WHERE t.organization_id = b.organization_id
                        AND (i.updated_at > i.created_at OR i.created_at > t.seeded_at))
    ) x;

  -- Every other table that references organizations: any row at all blocks.
  FOR v_fk IN
    SELECT c.conrelid::regclass AS rel, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = 'public.organizations'::regclass
       AND c.conrelid NOT IN ('public.organization_members'::regclass,
                              'public.organization_plans'::regclass,
                              'public.checklist_templates'::regclass)
     ORDER BY 1, 2
  LOOP
    EXECUTE format('SELECT count(*) FROM %s t WHERE t.%I IN (SELECT organization_id FROM public.backlog_3858_personal_org_backfill)',
                   v_fk.rel, v_fk.col) INTO v_n;
    IF v_n > 0 THEN
      v_bad := concat_ws(', ', v_bad, format('%s row(s) in %s', v_n, v_fk.rel));
    END IF;
  END LOOP;

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
