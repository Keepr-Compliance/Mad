-- BACKLOG-3704: licenses rows are written by server-side functions only.
--
-- Removes INSERT and UPDATE on public.licenses from PUBLIC, anon and
-- authenticated. Grants only: no policy, function or column changes.
--
-- Every write to licenses goes through a SECURITY DEFINER function owned by
-- the table owner, which keeps its privileges. SELECT is unchanged.
-- PUBLIC is listed for completeness; it holds no grant on this table today.

REVOKE INSERT, UPDATE ON TABLE public.licenses FROM PUBLIC, anon, authenticated;
