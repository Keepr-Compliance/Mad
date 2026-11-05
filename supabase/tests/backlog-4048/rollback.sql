-- BACKLOG-4048 rollback: restores both function bodies to the pre-4048 text (prosrc md5
-- 22c2a8f2df610fef3fba55b9085939fc and 79c10d873c207522fbf08c0f8e02af64), their comments,
-- and removes the helper. Privileges on the two functions are unchanged by 4048.
CREATE OR REPLACE FUNCTION public.org_billing_suspended(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.org_deals d
     WHERE d.organization_id = p_org AND d.status = 'suspended'
  );
$function$;
COMMENT ON FUNCTION public.org_billing_suspended(uuid) IS
  'BACKLOG-3853: the only suspension predicate. Executable by authenticated because RLS policies call it.';

CREATE OR REPLACE FUNCTION public.org_billing_service_off(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  -- BACKLOG-4019: suspended OR canceled. Submission and review gates read this.
  SELECT EXISTS (
    SELECT 1 FROM public.org_deals d
     WHERE d.organization_id = p_org AND d.status IN ('suspended', 'canceled')
  );
$function$;
COMMENT ON FUNCTION public.org_billing_service_off(uuid) IS NULL;

DROP FUNCTION IF EXISTS public._org_billing_state_visible(uuid);
