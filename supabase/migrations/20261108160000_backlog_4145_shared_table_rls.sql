-- BACKLOG-4145 M2 — shared-table SELECT policies read per permission / per report
--
-- Thirteen shared tables had a SELECT branch that let ANY internal role read every row
-- (has_internal_role(), or EXISTS internal_roles on the support tables). This migration replaces ONLY
-- that branch, per table, with:
--   * an admin permission check: (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY[...]))
--   * and/or report access: (SELECT public.report_my_access('<report key>')) IS NOT NULL
--   * and, on users / organization_members / audit_logs / licenses / organizations, the support
--     requester set from M1 (20261108150000): public.support_my_requester_ids() = requester_id of
--     every ticket for support.admin, of tickets assigned to the caller for support.view. Keyed on
--     requester_id only, never requester_email.
-- Every own-row, org-member and service-role branch is kept exactly as it was.
--
-- Support tickets and their child tables: the requester branches (requester_id, requester_email) no
-- longer exclude internal users, so an internal user without support.view still reads the tickets
-- they filed themselves. The internal_note exclusion on messages and attachments is kept.
--
-- The policies are changed IN PLACE with ALTER POLICY: same names, commands, roles and count. No
-- policy is added (permissive policies OR together, so an added policy would leave the old access
-- open). Every helper is caller-bound SECURITY DEFINER with EXECUTE granted to authenticated, and
-- every call is wrapped in (SELECT ...) so it runs once per statement.
--
-- Keys per table (readers: admin-portal):
--   users                 users.view, organizations.view
--                         reports analytics, exports, iphone-sync, google-messages-sync, email-precache,
--                         submissions, support-sla, user-activity
--                         (lib/reports/analytics-queries.ts:169,192; exports-queries.ts:75;
--                          iphone-sync-queries.ts:157 via iphone-sync, google-messages-sync and
--                          email-precache pages; submissions-queries.ts:116; support-sla-queries.ts:102;
--                          user-activity-queries.ts:77; app/dashboard/users/[id]/page.tsx:72;
--                          app/dashboard/organizations/[id]/page.tsx:91 users embed)
--                         + support requester
--   organizations         organizations.view, users.view, users.edit
--                         reports analytics, exports, submissions, user-activity
--                         (organizations/[id]/page.tsx:85; users/components/InviteUserDialog.tsx:78;
--                          users/[id]/page.tsx:78 embed; analytics-queries.ts:96,175;
--                          exports-queries.ts:93; submissions-queries.ts:123; user-activity-queries.ts:86)
--                         + organizations the support requester belongs to
--   organization_members  organizations.view, users.view
--                         reports analytics, exports, user-activity
--                         (organizations/[id]/page.tsx:90,96; users/[id]/page.tsx:77;
--                          analytics-queries.ts:113; exports-queries.ts:76; user-activity-queries.ts:83)
--                         + support requester (user_id)
--   devices               reports analytics, user-activity (analytics-queries.ts:69,162;
--                          user-activity-queries.ts:80). users/[id] reads devices through
--                          admin_list_user_devices (M1).
--   user_preferences      report analytics (analytics-queries.ts:131). Own rows are a separate policy.
--   audit_logs            users.view; report user-activity (users/[id]/page.tsx:88;
--                          user-activity-queries.ts:48) + support requester (user_id)
--   licenses              users.view (users/[id]/page.tsx:81; lib/suspension-queries.ts:98)
--                         + support requester (user_id)
--   support_tickets       support.view; report support-sla (support-sla-queries.ts:66,84)
--   support_ticket_messages / _events / _participants / _attachments   support.view
--   support_ticket_backlog_links   support.view, USING and WITH CHECK (PM readers without support.view
--                          use pm_list_backlog_ticket_links from M1)
--
-- Idempotent: ALTER POLICY sets the same text on every run.
-- Rollback: supabase/tests/backlog-4145-m2/rollback-4145-m2.sql (verbatim prior text).

-- ============================================================
-- 1. users
-- ============================================================
ALTER POLICY users_select_public ON public.users
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['users.view', 'organizations.view']))
    OR (SELECT public.report_my_access('analytics')) IS NOT NULL
    OR (SELECT public.report_my_access('exports')) IS NOT NULL
    OR (SELECT public.report_my_access('iphone-sync')) IS NOT NULL
    OR (SELECT public.report_my_access('google-messages-sync')) IS NOT NULL
    OR (SELECT public.report_my_access('email-precache')) IS NOT NULL
    OR (SELECT public.report_my_access('submissions')) IS NOT NULL
    OR (SELECT public.report_my_access('support-sla')) IS NOT NULL
    OR (SELECT public.report_my_access('user-activity')) IS NOT NULL
    OR (id IN (SELECT public.support_my_requester_ids()))
    OR (id IN ( SELECT om.user_id
         FROM organization_members om
        WHERE ((om.organization_id IN ( SELECT colleague_org.organization_id
                 FROM organization_members colleague_org
                WHERE ((colleague_org.user_id = ( SELECT auth.uid() AS uid)) AND member_status_grants_access((colleague_org.license_status)::text)))) AND (om.user_id IS NOT NULL))))
    OR (( SELECT auth.uid() AS uid) = id)
  );

-- ============================================================
-- 2. organizations
-- ============================================================
ALTER POLICY organizations_select_public ON public.organizations
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['organizations.view', 'users.view', 'users.edit']))
    OR (SELECT public.report_my_access('analytics')) IS NOT NULL
    OR (SELECT public.report_my_access('exports')) IS NOT NULL
    OR (SELECT public.report_my_access('submissions')) IS NOT NULL
    OR (SELECT public.report_my_access('user-activity')) IS NOT NULL
    OR (id IN ( SELECT req_org.organization_id
         FROM organization_members req_org
        WHERE (req_org.user_id IN (SELECT public.support_my_requester_ids()))))
    OR (id IN ( SELECT organization_members.organization_id
         FROM organization_members
        WHERE (organization_members.user_id = ( SELECT auth.uid() AS uid))))
  );

-- ============================================================
-- 3. organization_members
-- ============================================================
ALTER POLICY organization_members_select_public ON public.organization_members
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['organizations.view', 'users.view']))
    OR (SELECT public.report_my_access('analytics')) IS NOT NULL
    OR (SELECT public.report_my_access('exports')) IS NOT NULL
    OR (SELECT public.report_my_access('user-activity')) IS NOT NULL
    OR (user_id IN (SELECT public.support_my_requester_ids()))
    OR (organization_id IN ( SELECT get_user_org_ids(( SELECT auth.uid() AS uid)) AS get_user_org_ids))
    OR (user_id = ( SELECT auth.uid() AS uid))
  );

-- ============================================================
-- 4. devices
-- ============================================================
ALTER POLICY devices_select_public ON public.devices
  USING (
    (( SELECT auth.uid() AS uid) = user_id)
    OR (SELECT public.report_my_access('analytics')) IS NOT NULL
    OR (SELECT public.report_my_access('user-activity')) IS NOT NULL
  );

-- ============================================================
-- 5. user_preferences (own rows: user_preferences_select_own, unchanged)
-- ============================================================
ALTER POLICY user_preferences_select_internal ON public.user_preferences
  USING (
    (SELECT public.report_my_access('analytics')) IS NOT NULL
  );

-- ============================================================
-- 6. audit_logs
-- ============================================================
ALTER POLICY audit_logs_select_public ON public.audit_logs
  USING (
    (( SELECT auth.uid() AS uid) = user_id)
    OR (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['users.view']))
    OR (SELECT public.report_my_access('user-activity')) IS NOT NULL
    OR (user_id IN (SELECT public.support_my_requester_ids()))
  );

-- ============================================================
-- 7. licenses
-- ============================================================
ALTER POLICY licenses_select_public ON public.licenses
  USING (
    (( SELECT auth.uid() AS uid) = user_id)
    OR (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['users.view']))
    OR (user_id IN (SELECT public.support_my_requester_ids()))
  );

-- ============================================================
-- 8. support_tickets
-- ============================================================
ALTER POLICY support_tickets_select_public ON public.support_tickets
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.view']))
    OR (SELECT public.report_my_access('support-sla')) IS NOT NULL
    OR (requester_email = (auth.jwt() ->> 'email'::text))
    OR (requester_id = ( SELECT auth.uid() AS uid))
  );

-- ============================================================
-- 9. support_ticket_messages
-- ============================================================
ALTER POLICY support_ticket_messages_select_public ON public.support_ticket_messages
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.view']))
    OR ((message_type <> 'internal_note'::text) AND (EXISTS ( SELECT 1
         FROM support_tickets t
        WHERE ((t.id = support_ticket_messages.ticket_id) AND ((t.requester_id = ( SELECT auth.uid() AS uid)) OR (t.requester_email = (( SELECT users.email
                 FROM auth.users
                WHERE (users.id = ( SELECT auth.uid() AS uid))))::text))))))
  );

-- ============================================================
-- 10. support_ticket_events
-- ============================================================
ALTER POLICY support_ticket_events_select_public ON public.support_ticket_events
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.view']))
    OR (EXISTS ( SELECT 1
         FROM support_tickets t
        WHERE ((t.id = support_ticket_events.ticket_id) AND ((t.requester_id = ( SELECT auth.uid() AS uid)) OR (t.requester_email = (( SELECT users.email
                 FROM auth.users
                WHERE (users.id = ( SELECT auth.uid() AS uid))))::text)))))
  );

-- ============================================================
-- 11. support_ticket_participants
-- ============================================================
ALTER POLICY support_ticket_participants_select_public ON public.support_ticket_participants
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.view']))
    OR (EXISTS ( SELECT 1
         FROM support_tickets t
        WHERE ((t.id = support_ticket_participants.ticket_id) AND ((t.requester_id = ( SELECT auth.uid() AS uid)) OR (t.requester_email = (( SELECT users.email
                 FROM auth.users
                WHERE (users.id = ( SELECT auth.uid() AS uid))))::text)))))
  );

-- ============================================================
-- 12. support_ticket_attachments
-- ============================================================
ALTER POLICY support_ticket_attachments_select_public ON public.support_ticket_attachments
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.view']))
    OR ((EXISTS ( SELECT 1
         FROM support_tickets t
        WHERE ((t.id = support_ticket_attachments.ticket_id) AND ((t.requester_id = ( SELECT auth.uid() AS uid)) OR (t.requester_email = (( SELECT users.email
                 FROM auth.users
                WHERE (users.id = ( SELECT auth.uid() AS uid))))::text))))) AND ((message_id IS NULL) OR (EXISTS ( SELECT 1
         FROM support_ticket_messages m
        WHERE ((m.id = support_ticket_attachments.message_id) AND (m.message_type <> 'internal_note'::text))))))
  );

-- ============================================================
-- 13. support_ticket_backlog_links (FOR ALL: USING and WITH CHECK)
-- ============================================================
ALTER POLICY support_ticket_backlog_links_internal_all ON public.support_ticket_backlog_links
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.view']))
  )
  WITH CHECK (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.view']))
  );
