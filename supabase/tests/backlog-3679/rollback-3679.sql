-- BACKLOG-3679 rollback: restores the pre-migration policy, removes the
-- invitee SELECT policy and the guard trigger/function.
DROP TRIGGER IF EXISTS guard_invite_acceptance ON public.organization_members;
DROP FUNCTION IF EXISTS public.guard_invite_acceptance();
DROP POLICY IF EXISTS users_can_view_own_invite ON public.organization_members;
DROP POLICY IF EXISTS users_can_accept_invite ON public.organization_members;
CREATE POLICY users_can_accept_invite ON public.organization_members
  FOR UPDATE TO public
  USING (invited_email = ((SELECT users.email FROM auth.users WHERE users.id = (SELECT auth.uid() AS uid)))::text);
