-- Migration: analytics_events internal-role read access for the paywall funnel dashboard (BACKLOG-2014)
--
-- PURPOSE
--   BACKLOG-2014 adds an admin-portal "paywall funnel" dashboard that reads the
--   already-flowing funnel events (paywall-viewed -> unlock-clicked ->
--   payment-succeeded -> export-completed) so the founder can tell a price
--   problem apart from paywall-confusion apart from a broken checkout.
--
--   DISCREPANCY vs the original 2014 scope (recorded on the backlog item):
--   the spec assumed a NEW paywall_funnel_events table + fresh emission wiring.
--   In reality ALL FOUR funnel events already emit into the EXISTING
--   analytics_events table:
--     * paywall-viewed / unlock-clicked / export-completed
--         -> desktop main process via supabaseService.trackEvent (BACKLOG-2006a)
--     * payment-succeeded
--         -> broker-portal server-side via emitPaymentSucceeded (BACKLOG-2005a)
--   Standing up a SECOND table would fragment live data and orphan shipped
--   emission, so the dashboard READS analytics_events instead. Emission is fully
--   wired; nothing is deferred.
--
--   The one true gap this migration closes: analytics_events RLS today is only
--   `service_role ALL` + `users insert own` (verified live). There is NO
--   internal-role SELECT, so the admin dashboard's authenticated (anon-key +
--   internal-role) server client cannot read it. The existing analytics page
--   relies on internal-role cross-org SELECT policies (TASK-2110); this migration
--   grants analytics_events the SAME policy shape.
--
-- CHANGES
--   1. RLS SELECT policy allowing a user to read their OWN events OR, if they hold
--      an internal role, ALL events. Mirrors the canonical devices_select_public
--      shape: (auth.uid() = user_id) OR has_internal_role(auth.uid()).
--      This is PURELY ADDITIVE for internal users; a normal user still only ever
--      sees their own rows, and there is no non-internal path to other users' data.
--   2. A created_at index so the dashboard's date-range filter and the
--      funnel-event scan stay index-backed as the table grows.
--
-- SECURITY
--   Read-only. No new write paths. Internal-role gating uses the same
--   SECURITY DEFINER has_internal_role(uuid) helper used across the portal.

-- 1. Internal-role (and own-row) SELECT on analytics_events.
--    Idempotent: drop-if-exists so re-running the migration is safe.
DROP POLICY IF EXISTS analytics_events_select_own_or_internal ON public.analytics_events;

CREATE POLICY analytics_events_select_own_or_internal
  ON public.analytics_events
  FOR SELECT
  USING (
    ((SELECT auth.uid()) = user_id)
    OR has_internal_role((SELECT auth.uid()))
  );

-- 2. created_at index to keep date-range filtering on the funnel dashboard fast.
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at
  ON public.analytics_events USING btree (created_at);
