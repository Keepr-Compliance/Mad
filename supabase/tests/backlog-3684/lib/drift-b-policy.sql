-- Drift fixture for B: users_can_view_own_invite was changed by someone else.
ALTER POLICY users_can_view_own_invite ON public.organization_members USING (user_id IS NULL);
