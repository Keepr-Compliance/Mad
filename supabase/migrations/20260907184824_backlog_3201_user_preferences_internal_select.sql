-- Migration: internal-role SELECT on user_preferences (BACKLOG-3201)
--
-- PURPOSE
--   The admin analytics dashboard's "Phone Type" card reads user_preferences
--   through the AUTHENTICATED server client, as every other query on that page
--   does. RLS on user_preferences grants SELECT only via
--   user_preferences_select_own (auth.uid() = user_id) plus a service_role
--   policy. There is no internal-role SELECT, so an internal-role admin reads
--   exactly one row: their own. The card therefore charts a single preference
--   and reports it as 100%.
--
--   devices and users both received an internal-role SELECT under TASK-2110
--   (devices_select_public, users_select_public, both keyed on
--   has_internal_role(auth.uid())). user_preferences was missed. This migration
--   closes that gap with the same policy shape.
--
--   Measured under RLS before this migration, in a session with
--   `set local role authenticated` and an internal-role admin's uid:
--   user_preferences returns 1 row while devices returns 23 and users 23.
--
-- WHY A POLICY AND NOT A SERVICE CLIENT
--   analytics-queries.ts states, as a file-level invariant, that its queries run
--   as the authenticated user under RLS. Swapping this one query to the service
--   role would keep the invariant's comment and break the invariant. The
--   read-permission gap is the actual defect, so the policy is the actual fix.
--
-- SCOPE
--   Read-only and purely additive. user_preferences_select_own is untouched —
--   the desktop app depends on it. No new write path. A non-internal user still
--   sees only their own row. Internal roles already read devices and users
--   cross-org, so this grants no new class of access.
--
--   Idempotent: drop-if-exists, so re-running is safe.

DROP POLICY IF EXISTS user_preferences_select_internal ON public.user_preferences;

CREATE POLICY user_preferences_select_internal
  ON public.user_preferences
  FOR SELECT
  USING (has_internal_role((SELECT auth.uid())));
