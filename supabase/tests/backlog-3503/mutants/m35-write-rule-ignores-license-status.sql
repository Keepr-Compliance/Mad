-- The write rule exactly as it stood before the founder's ruling: the
-- organization and the role, and no license_status. A DEACTIVATED broker or
-- admin keeps the office-wide read and keeps writing new agreements -- the
-- membership row is still there and still says 'broker', so nothing else in the
-- rule notices.
--
-- The body below is byte-identical to the pre-ruling helper, so the ONLY
-- difference from the shipped file is the status term. That is what makes its
-- RED set evidence about that term and nothing else.
CREATE OR REPLACE FUNCTION public.can_write_split_agreements(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org_id
                    AND m.user_id = (SELECT auth.uid())
                    AND m.role IN ('broker', 'admin'));
$fn$;
DO $m$ BEGIN
  IF position('license_status' in (SELECT prosrc FROM pg_proc
       WHERE oid='public.can_write_split_agreements(uuid)'::regprocedure)) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;
  -- and the rest of the rule is still there: a mutant that emptied the body
  -- would red these controls too, for a different reason.
  IF position('m.role' in (SELECT prosrc FROM pg_proc
       WHERE oid='public.can_write_split_agreements(uuid)'::regprocedure)) = 0
   OR position('m.organization_id = p_org_id' in (SELECT prosrc FROM pg_proc
       WHERE oid='public.can_write_split_agreements(uuid)'::regprocedure)) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the role or org term went missing too'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: the write rule no longer checks license_status (a deactivated broker keeps reading and writing)';
