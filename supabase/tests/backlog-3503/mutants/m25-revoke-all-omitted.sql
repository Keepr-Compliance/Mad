-- The likeliest wrong version of this migration: the
-- `REVOKE ALL ... FROM anon, authenticated` line is simply not written.
-- Supabase's default ACL has already granted `arwdDxtm` on the new table to
-- anon and authenticated, so this restores exactly the state the file would
-- leave behind. The column-list GRANT INSERT is additive on top of it.
GRANT ALL ON public.agent_split_agreements TO anon, authenticated;
DO $m$ BEGIN
  IF NOT (has_column_privilege('authenticated','public.agent_split_agreements','set_by','INSERT')
      AND has_table_privilege('anon','public.agent_split_agreements','SELECT')
      AND has_table_privilege('authenticated','public.agent_split_agreements','DELETE'))
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: REVOKE ALL omitted -- the default ACL grant stands';
