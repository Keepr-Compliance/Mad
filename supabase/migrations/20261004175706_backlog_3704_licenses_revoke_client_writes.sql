-- BACKLOG-3704: licenses rows are written by server-side functions only.
--
-- Removes INSERT and UPDATE on public.licenses from PUBLIC, anon and
-- authenticated, and drops the two write policies on the table
-- ("Users can insert own license", "Users can update own license").
-- The SELECT policy, functions and columns are unchanged.
--
-- Every write to licenses goes through a SECURITY DEFINER function owned by
-- the table owner, which keeps its privileges.
-- PUBLIC is listed for completeness; it holds no grant on this table today.

REVOKE INSERT, UPDATE ON TABLE public.licenses FROM PUBLIC, anon, authenticated;

DROP POLICY "Users can insert own license" ON public.licenses;
DROP POLICY "Users can update own license" ON public.licenses;
