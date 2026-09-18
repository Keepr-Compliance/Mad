-- ============================================================================
-- Migration: Add the desktop_hide_from_export feature definition (OFF everywhere)
-- Backlog: BACKLOG-3365
-- Purpose:
--   Give "hide a text from an export" a plan feature of its own, so it is
--   something a customer's plan grants rather than something every customer
--   gets.
--
-- NOT APPLIED TO PRODUCTION BY THIS PR.
--   The file ships; the apply is a separate, deliberate act that needs the
--   founder's word, and it goes out with the BACKLOG-3366 release. The admin
--   plan editor renders every feature_definitions row and ignores is_built, so
--   applying this early would put a live-looking switch in front of him that
--   does nothing.
--
--   Until the apply, the key is simply ABSENT for every organization — and an
--   absent key reads BLOCKED through the strict gate, not allowed. Every row
--   below is written false, so the state the moment after the apply is the same
--   state as the moment before it. The deploy order genuinely does not matter.
--
-- ---------------------------------------------------------------------------
-- What this key does and does NOT gate
-- ---------------------------------------------------------------------------
--   It gates ONLY the ability to HIDE. The export never consults it and always
--   honours texts that are already hidden — a plan change must not resurrect
--   hidden texts into an audit package a third party has been given. Unhide is
--   never gated either: a user who loses the feature must still be able to put
--   a text back into their own export.
--
-- ---------------------------------------------------------------------------
-- Why the key is named for the capability and not for texts
-- ---------------------------------------------------------------------------
--   Only texts can be hidden today. The founder's ruling (epic BACKLOG-3227)
--   is that email hiding, when it arrives, reuses this same switch rather than
--   arriving as a second row he has to remember to turn on per customer.
--
-- ---------------------------------------------------------------------------
-- default_value 'false' is the load-bearing line, NOT the plan_features rows
-- ---------------------------------------------------------------------------
--   get_org_features looks up organization_plans first. An organization with NO
--   plan row never consults plan_features at all and falls straight through to
--   feature_definitions.default_value for every key. Seeding only plan_features
--   would therefore leave the feature at whatever the default said for exactly
--   the plan-less organizations. Both are written: default_value covers those,
--   plan_features covers organizations on a plan, and the two agree.
--
--   min_tier NULL: every plan may carry this feature. It is not a tier
--   privilege; it is a switch the founder turns on per customer.
--
--   is_built = false: BACKLOG-3366 ships the control this gates. That release
--   flips it to true.
-- ============================================================================

INSERT INTO public.feature_definitions
  (key, name, description, category, value_type, default_value, min_tier, sort_order, is_built)
VALUES (
  'desktop_hide_from_export',
  'Hide from export',
  'Lets a user keep an individual text out of a transaction export. The text stays linked to the transaction and stays visible in the app; only the export drops it. Unhiding is never gated. Off unless a plan or an organization override turns it on (BACKLOG-3365).',
  'export',
  'boolean',
  'false',
  NULL,
  46,
  false
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
SELECT p.id, fd.id, false, 'false'
FROM public.plans p
CROSS JOIN public.feature_definitions fd
WHERE fd.key = 'desktop_hide_from_export'
ON CONFLICT (plan_id, feature_id) DO NOTHING;
