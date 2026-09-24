-- REBASED onto the shipped helper body (SR impl review, pm_comments b60c8ffb).
-- The first version of this mutant CREATE OR REPLACEd a PRE-RULING body, so it
-- dropped the license_status term as a side effect and gained a c24 red that
-- said nothing about the organization term it names. Rebased: the status term
-- stays, the org term goes, and the RED set is evidence about the org term only.
--
-- One red that survives and is worth reading: c23. With the org term gone, the
-- ACTIVE broker of org A over-reads org B's row, so c23's positive arm -- "the
-- active broker still reads all 7" -- fails at 8. That is a real finding about
-- the org term, not an artifact.
CREATE OR REPLACE FUNCTION public.can_write_commission_agreements(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.organization_members m
                        WHERE m.user_id = (SELECT auth.uid())
                          AND m.role IN ('broker','admin')
                          AND m.license_status = 'active'); $fn$;
DO $m$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE oid='public.can_write_commission_agreements(uuid)'::regprocedure;
  IF position('m.organization_id' in src) > 0 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;
  -- everything else is still there, so the reds are about the org term alone
  IF position('license_status' in src) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the status term went with it'; END IF;
  IF position('m.role' in src) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the role term went with it'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: the write rule no longer checks WHICH org the caller is a broker of';
