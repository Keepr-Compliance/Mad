-- ============================================================================
-- Migration: transaction checklists -- the owner of a personal organization
--            edits that organization's templates; starters follow min_tier
-- Backlog: BACKLOG-3535 items 2 and 4 (epic BACKLOG-2237)
--
-- What changes
-- ---------------------------------------------------------------------------
--   1. can_edit_checklist_templates(p_org_id): a member of p_org_id may edit
--      when their role is broker / admin / it_admin (unchanged) OR they are
--      that organization's personal owner (organizations.personal_owner_user_id
--      = the member's user_id). The owner clause sits INSIDE the membership
--      EXISTS: the owner must be a current member of p_org_id. A former solo
--      user whose personal membership was retired when they joined a
--      brokerage is refused on the personal organization by this rule itself.
--      The feature is still decided by check_feature_access(); no tier is
--      named here.
--
--   2. _seed_checklists_on_plan_write(): the floor below which an
--      organization gets no starter copies moves from the literal
--      tier_rank('team') to the tier_rank of feature_definitions.min_tier for
--      'transaction_checklists' (now 'individual', 20260924183422). Why the
--      floor follows min_tier and not the plan's entitlement:
--        - it is the rule teams already live under: teams are seeded today
--          while the Team plan_features row is false. "Tier is eligible", not
--          "entitled now".
--        - the trigger fires only on organization_plans INSERT / UPDATE OF
--          plan_id. There is NO trigger on plan_features, so a floor that
--          followed entitlement would leave every solo organization unseeded
--          at the moment the Individual plan row is switched on.
--        - check_feature_access() refuses a caller who is not a member, and
--          auth.uid() is NULL in the sign-in / admin writers of plan rows.
--        - one source for "which tiers can ever have checklists": starters and
--          entitlement cannot drift apart again.
--      A NULL min_tier (or a missing feature row) reads as rank 0: no floor.
--
-- Effect on apply: none for any user. The Individual plan row for
-- transaction_checklists is false and no organization holds an override for
-- it, so check_feature_access() is false for every personal organization.
-- Access appears only when the Individual row is switched on or a
-- per-organization override is written.
--
-- Seeding at first sign-in: _ensure_personal_organization_for now reaches
-- _seed_org_checklist_templates (plan row INSERT -> this trigger). A seed
-- failure rolls back ensure_personal_organization; the desktop logs it and
-- retries at the next sign-in. Sign-in itself does not fail; the user is
-- without a plan of record until the retry succeeds.
--
-- BACKFILL -- run after catalogue content lands (supersedes the comment in
-- 20260921101757_backlog_3473_transaction_checklists.sql, which excluded
-- personal organizations). The trigger only fires on a plan write, so
-- organizations that already hold a plan row get starters from THIS query,
-- not from the trigger. Idempotent: ON CONFLICT (organization_id, seed_key)
-- DO NOTHING, so an archived starter is not re-created. Nothing to backfill
-- today: the catalogue is empty.
--
--   SELECT public._seed_org_checklist_templates(op.organization_id)
--   FROM public.organization_plans op
--   JOIN public.plans p ON p.id = op.plan_id
--   WHERE public.tier_rank(p.tier) >= public.tier_rank(
--           (SELECT min_tier FROM public.feature_definitions WHERE key = 'transaction_checklists'));
--
-- ROLLBACK (the bodies live before this migration, verbatim in substance):
--
--   CREATE OR REPLACE FUNCTION public.can_edit_checklist_templates(p_org_id uuid)
--   RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
--   AS $$
--     SELECT EXISTS (
--              SELECT 1
--                FROM public.organization_members m
--               WHERE m.organization_id = p_org_id
--                 AND m.user_id = (SELECT auth.uid())
--                 AND m.role IN ('broker', 'admin', 'it_admin')
--            )
--        AND COALESCE((public.check_feature_access(p_org_id, 'transaction_checklists') ->> 'allowed')::boolean, false);
--   $$;
--
--   CREATE OR REPLACE FUNCTION public._seed_checklists_on_plan_write()
--   RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
--   AS $$
--   BEGIN
--     IF public.tier_rank((SELECT p.tier FROM public.plans p WHERE p.id = NEW.plan_id))
--        < public.tier_rank('team') THEN
--       RETURN NULL;
--     END IF;
--     PERFORM public._seed_org_checklist_templates(NEW.organization_id);
--     RETURN NULL;
--   END
--   $$;
--
-- Grants: unchanged. CREATE OR REPLACE keeps each function's ACL
-- (can_edit_checklist_templates: authenticated; the trigger function: none).
-- Re-runnable: CREATE OR REPLACE only. No BEGIN/COMMIT: the caller supplies
-- the transaction.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.can_edit_checklist_templates(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
           SELECT 1
             FROM public.organization_members m
             JOIN public.organizations o ON o.id = m.organization_id
            WHERE m.organization_id = p_org_id
              AND m.user_id = (SELECT auth.uid())
              AND (m.role IN ('broker', 'admin', 'it_admin')
                   OR o.personal_owner_user_id = m.user_id)
         )
     AND COALESCE((public.check_feature_access(p_org_id, 'transaction_checklists') ->> 'allowed')::boolean, false);
$$;

CREATE OR REPLACE FUNCTION public._seed_checklists_on_plan_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.tier_rank((SELECT p.tier FROM public.plans p WHERE p.id = NEW.plan_id))
     < public.tier_rank((SELECT fd.min_tier FROM public.feature_definitions fd
                          WHERE fd.key = 'transaction_checklists')) THEN
    RETURN NULL;
  END IF;
  PERFORM public._seed_org_checklist_templates(NEW.organization_id);
  RETURN NULL;
END
$$;
