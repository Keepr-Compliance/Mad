-- ============================================================================
-- Migration: feature_definitions.is_built — "gray what a plan gates, hide what
--            doesn't exist", moved out of the portal and into the database
-- Backlog: BACKLOG-3098
--
-- Purpose:
--   BACKLOG-3078 shipped the gray-vs-hide rule with the unbuilt keys written
--   into a TypeScript constant in the broker portal (UNBUILT_FEATURES), a
--   deliberate shortcut the founder approved on 2026-09-04. The cost of that
--   shortcut is that shipping SCIM would need a portal deploy to stop hiding
--   the card. This column is the "later" that removes it.
--
-- ---------------------------------------------------------------------------
-- Why a second column, when `enabled` already reads false for both
-- ---------------------------------------------------------------------------
--   A team-plan org has custom_retention false and scim_provisioning false.
--   One is false because the plan does not include it; the other is false
--   because the feature has never been built. The portal must render those two
--   differently — the first GRAYED with a label naming what unlocks it, the
--   second ABSENT, because graying advertises a purchase and no plan can
--   deliver SCIM today. A single boolean cannot carry that distinction, so it
--   has to live somewhere explicit. Here.
--
--   After this migration, shipping SCIM is a data change: set is_built = true
--   on that row and the card starts graying (or, with the feature switched on
--   per plan or per org, renders enabled) with no deploy.
--
-- ---------------------------------------------------------------------------
-- DEFAULT true is the safe default FOR THE DATA, and it is the only one
-- ---------------------------------------------------------------------------
--   Every one of the 23 existing rows describes a feature that exists; only
--   the two named below do not. Defaulting to false would mark all 23 unbuilt
--   and hide every gated control in the portal at once. Defaulting to true and
--   naming the exceptions is both correct today and the honest description of
--   a new feature row: a row someone bothered to create describes something
--   real unless they say otherwise.
--
--   NOTE the asymmetry, which is deliberate: the DEFAULT is permissive, but the
--   portal's fallback when it CANNOT READ this column at all is restrictive
--   (hidden). Those answer different questions — "what is true of a new row"
--   versus "what do we render when we know nothing".
--
-- Why the two keys below:
--   - scim_provisioning: the `scim` edge function has never been deployed; the
--     endpoint the settings page hands out returns 404 (BACKLOG-3087 / 2241).
--   - jit_provisioning: every JIT join fails and signs the user out — the
--     portal calls a two-argument jit_join_organization that production does
--     not have, and the one-argument form has EXECUTE revoked from
--     `authenticated` (BACKLOG-3094 / 1954).
--
-- Prerequisites:
--   - 20260903_backlog_3087_scim_provisioning_feature.sql (seeds scim_provisioning)
--   - 20260904_backlog_3094_jit_provisioning_feature.sql  (seeds jit_provisioning)
--
-- Deploy order (matters):
--   Apply this BEFORE deploying the portal change that reads the column. The
--   portal treats an unreadable is_built as unbuilt and hides the control, so a
--   portal deploy that lands first blanks the gated cards on /dashboard/settings
--   until this runs.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, and the UPDATE is idempotent (it sets
--   an absolute value, not a toggle).
-- ============================================================================

-- ============================================================================
-- 1. THE COLUMN
-- ============================================================================

ALTER TABLE public.feature_definitions
  ADD COLUMN IF NOT EXISTS is_built boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.feature_definitions.is_built IS
  'Does this feature exist at all? false means no plan can deliver it, so the '
  'broker portal renders its control ABSENT rather than grayed — graying would '
  'advertise a purchase we cannot honour. Distinct from enabled/plan_features, '
  'which answer whether THIS ORG has bought a feature that does exist. '
  'BACKLOG-3098.';

-- ============================================================================
-- 2. THE TWO EXCEPTIONS
-- ============================================================================
-- Exactly these keys, and no others. Every other row describes something that
-- works, and keeps the column default of true.

UPDATE public.feature_definitions
SET is_built = false
WHERE key IN ('scim_provisioning', 'jit_provisioning');
