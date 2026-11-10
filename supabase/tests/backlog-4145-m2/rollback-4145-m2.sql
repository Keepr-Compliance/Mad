-- BACKLOG-4145 M2 rollback: restores the 13 policies changed by 20261108160000 to the text read from
-- the production catalog on 2026-11-07 (pg_policies quals, verbatim; identical on keepr-test).
-- Digest of the 31 policies on the 13 tables before M2 (see controls.sql K2):
--   n=31 md5=83dce5f806f9431a9eead58e9f61ea89
-- Rollback order: this file BEFORE the M1 rollback (the policies here use M1's helper).
-- Run only inside a transaction that is rolled back (harness), or with an explicit go for a real rollback.

ALTER POLICY users_select_public ON public.users
  USING ((has_internal_role(( SELECT auth.uid() AS uid)) OR (id IN ( SELECT om.user_id
   FROM organization_members om
  WHERE ((om.organization_id IN ( SELECT colleague_org.organization_id
           FROM organization_members colleague_org
          WHERE ((colleague_org.user_id = ( SELECT auth.uid() AS uid)) AND member_status_grants_access((colleague_org.license_status)::text)))) AND (om.user_id IS NOT NULL)))) OR (( SELECT auth.uid() AS uid) = id)));

ALTER POLICY organizations_select_public ON public.organizations
  USING ((has_internal_role(( SELECT auth.uid() AS uid)) OR (id IN ( SELECT organization_members.organization_id
   FROM organization_members
  WHERE (organization_members.user_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY organization_members_select_public ON public.organization_members
  USING ((has_internal_role(( SELECT auth.uid() AS uid)) OR (organization_id IN ( SELECT get_user_org_ids(( SELECT auth.uid() AS uid)) AS get_user_org_ids)) OR (user_id = ( SELECT auth.uid() AS uid))));

ALTER POLICY devices_select_public ON public.devices
  USING (((( SELECT auth.uid() AS uid) = user_id) OR has_internal_role(( SELECT auth.uid() AS uid))));

ALTER POLICY user_preferences_select_internal ON public.user_preferences
  USING (has_internal_role(( SELECT auth.uid() AS uid)));

ALTER POLICY audit_logs_select_public ON public.audit_logs
  USING (((( SELECT auth.uid() AS uid) = user_id) OR has_internal_role(( SELECT auth.uid() AS uid))));

ALTER POLICY licenses_select_public ON public.licenses
  USING (((( SELECT auth.uid() AS uid) = user_id) OR has_internal_role(( SELECT auth.uid() AS uid))));

ALTER POLICY support_tickets_select_public ON public.support_tickets
  TO public
  USING (((EXISTS ( SELECT 1
   FROM internal_roles
  WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid)))) OR ((requester_email = (auth.jwt() ->> 'email'::text)) AND (NOT (EXISTS ( SELECT 1
   FROM internal_roles
  WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid)))))) OR ((requester_id = ( SELECT auth.uid() AS uid)) AND (NOT (EXISTS ( SELECT 1
   FROM internal_roles
  WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid))))))));

ALTER POLICY support_ticket_messages_select_public ON public.support_ticket_messages
  TO public
  USING (((EXISTS ( SELECT 1
   FROM internal_roles
  WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid)))) OR ((message_type <> 'internal_note'::text) AND (EXISTS ( SELECT 1
   FROM support_tickets t
  WHERE ((t.id = support_ticket_messages.ticket_id) AND ((t.requester_id = ( SELECT auth.uid() AS uid)) OR (t.requester_email = (( SELECT users.email
           FROM auth.users
          WHERE (users.id = ( SELECT auth.uid() AS uid))))::text))))) AND (NOT (EXISTS ( SELECT 1
   FROM internal_roles
  WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid))))))));

ALTER POLICY support_ticket_events_select_public ON public.support_ticket_events
  TO public
  USING (((EXISTS ( SELECT 1
   FROM internal_roles
  WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid)))) OR ((EXISTS ( SELECT 1
   FROM support_tickets t
  WHERE ((t.id = support_ticket_events.ticket_id) AND ((t.requester_id = ( SELECT auth.uid() AS uid)) OR (t.requester_email = (( SELECT users.email
           FROM auth.users
          WHERE (users.id = ( SELECT auth.uid() AS uid))))::text))))) AND (NOT (EXISTS ( SELECT 1
   FROM internal_roles
  WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid))))))));

ALTER POLICY support_ticket_participants_select_public ON public.support_ticket_participants
  TO public
  USING (((EXISTS ( SELECT 1
   FROM internal_roles
  WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid)))) OR ((EXISTS ( SELECT 1
   FROM support_tickets t
  WHERE ((t.id = support_ticket_participants.ticket_id) AND ((t.requester_id = ( SELECT auth.uid() AS uid)) OR (t.requester_email = (( SELECT users.email
           FROM auth.users
          WHERE (users.id = ( SELECT auth.uid() AS uid))))::text))))) AND (NOT (EXISTS ( SELECT 1
   FROM internal_roles
  WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid))))))));

ALTER POLICY support_ticket_attachments_select_public ON public.support_ticket_attachments
  TO public
  USING (((EXISTS ( SELECT 1
   FROM internal_roles
  WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid)))) OR ((EXISTS ( SELECT 1
   FROM support_tickets t
  WHERE ((t.id = support_ticket_attachments.ticket_id) AND ((t.requester_id = ( SELECT auth.uid() AS uid)) OR (t.requester_email = (( SELECT users.email
           FROM auth.users
          WHERE (users.id = ( SELECT auth.uid() AS uid))))::text))))) AND ((message_id IS NULL) OR (EXISTS ( SELECT 1
   FROM support_ticket_messages m
  WHERE ((m.id = support_ticket_attachments.message_id) AND (m.message_type <> 'internal_note'::text))))) AND (NOT (EXISTS ( SELECT 1
   FROM internal_roles
  WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid))))))));

ALTER POLICY support_ticket_backlog_links_internal_all ON public.support_ticket_backlog_links
  USING (has_internal_role(( SELECT auth.uid() AS uid)))
  WITH CHECK (has_internal_role(( SELECT auth.uid() AS uid)));

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261108160000';
