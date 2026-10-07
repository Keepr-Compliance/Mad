GRANT INSERT (set_by) ON public.agent_split_agreements TO authenticated;
DO $m$ BEGIN
  IF NOT has_column_privilege('authenticated','public.agent_split_agreements','set_by','INSERT')
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: set_by added to the INSERT grant';
