GRANT DELETE ON public.agent_split_agreements TO authenticated;
DO $m$ BEGIN
  IF NOT has_table_privilege('authenticated','public.agent_split_agreements','DELETE')
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: DELETE granted, NO delete policy added';
