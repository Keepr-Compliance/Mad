-- BACKLOG-3962 PR2 rollback: restore the PR1 body of _domain_claims_due_for_recheck(integer).
-- Same signature, so the grants are kept. The text between the $function$ markers is the PR1 text
-- byte for byte (md5 dc93015cbbcc7f6a77bcd8325f3a02d9). Remove the ledger row by hand if one was added.
CREATE OR REPLACE FUNCTION public._domain_claims_due_for_recheck(p_limit integer)
RETURNS TABLE (claim_id uuid, organization_id uuid, domain text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT c.id FROM public.domain_claims c
     WHERE c.status IN ('verified', 'lapsed')
       AND (c.last_checked_at IS NULL OR c.last_checked_at < now() - interval '20 hours')
     ORDER BY c.last_checked_at NULLS FIRST
     LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.domain_claims d
     SET last_checked_at = now(), updated_at = now()
    FROM due
   WHERE d.id = due.id
  RETURNING d.id, d.organization_id, d.domain;
END;
$function$;
