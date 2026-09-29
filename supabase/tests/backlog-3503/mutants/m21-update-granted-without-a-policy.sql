-- STEP 0 flagged this as unknown: a grant WITHOUT a policy makes UPDATE a silent
-- 0-row no-op rather than an error. This measures which it is.
GRANT UPDATE (agent_pct) ON public.agent_split_agreements TO authenticated;
DO $m$ BEGIN
  IF NOT has_column_privilege('authenticated','public.agent_split_agreements','agent_pct','UPDATE')
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: UPDATE granted, NO update policy added';
