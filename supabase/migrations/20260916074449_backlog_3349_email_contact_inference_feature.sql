-- ============================================================================
-- Migration: Add the email_contact_inference feature definition (OFF everywhere)
-- Backlog: BACKLOG-3349
-- Purpose:
--   Give "build contact records from the people in synced email" a plan feature
--   of its own, so it is something a customer's plan grants rather than
--   something every customer gets.
--
-- NOT APPLIED TO PRODUCTION BY THIS PR.
--   The file ships; the apply is a separate, deliberate act that needs the
--   founder's word. Until it happens the key is simply absent, and an absent
--   key reads as BLOCKED through the strict gate — which is also the state of
--   every organization the moment after the apply, because every row below is
--   written false. So the deploy order genuinely does not matter, and a build
--   that ships first is not wrong about anything.
--
-- ---------------------------------------------------------------------------
-- Why the key is named for the capability and not for Outlook
-- ---------------------------------------------------------------------------
--   Only the Outlook surface is wired to it today; Gmail arrives with
--   BACKLOG-1717. A provider-named key would have forced a second key, a second
--   migration, a second production apply and a second switch for the founder to
--   remember per customer -- and a customer with one on and one off would see a
--   live switch beside a greyed switch that do the same kind of thing. Whether
--   Gmail shares this key is the founder's call; if he wants them separate, the
--   second key is a new row here and one line in the provider map.
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
--   is_built = false: nothing delivers this feature until BACKLOG-1717 ships
--   the records it gates. That release flips it to true.
-- ============================================================================

INSERT INTO public.feature_definitions
  (key, name, description, category, value_type, default_value, min_tier, sort_order, is_built)
VALUES (
  'email_contact_inference',
  'Contacts from email',
  'Builds unsaved contact records from the people in synced email; the user confirms a record before it becomes a contact. Off unless a plan or an organization override turns it on (BACKLOG-3349).',
  'general',
  'boolean',
  'false',
  NULL,
  161,
  false
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
SELECT p.id, fd.id, false, 'false'
FROM public.plans p
CROSS JOIN public.feature_definitions fd
WHERE fd.key = 'email_contact_inference'
ON CONFLICT (plan_id, feature_id) DO NOTHING;
