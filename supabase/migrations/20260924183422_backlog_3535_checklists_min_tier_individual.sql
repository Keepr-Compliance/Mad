-- ============================================================================
-- Migration: transaction checklists -- min_tier individual
-- Backlog: BACKLOG-3535 (epic BACKLOG-2237)
--
-- What changes
-- ---------------------------------------------------------------------------
--   feature_definitions.min_tier for key 'transaction_checklists' moves from
--   'team' to 'individual'. That is the only effect: it lets
--   admin_update_plan_feature turn the feature ON for the Individual plan,
--   because that function refuses to enable a feature for a plan whose
--   tier_rank is below the feature's min_tier, and Individual's tier_rank (1)
--   sits below 'team' (2) but not below 'individual' (1).
--
--   This migration does NOT enable the feature on any plan. The Individual
--   row in plan_features stays enabled = false. The founder flips it in the
--   admin plan editor once solo template building exists (BACKLOG-3535 items
--   2-5) -- flipping it before then would show the feature to solo users with
--   no way to build a template for it.
--
-- Re-runnable: the WHERE clause only matches the row while it still reads
-- 'team', so re-applying this file after it has taken effect is a no-op.
-- No BEGIN/COMMIT: the caller supplies the transaction.
-- ============================================================================

UPDATE public.feature_definitions
   SET min_tier = 'individual', updated_at = now()
 WHERE key = 'transaction_checklists'
   AND min_tier = 'team';
