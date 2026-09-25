-- REBASED onto the shipped helper body (SR impl review, pm_comments b60c8ffb).
-- The first version replaced a PRE-RULING body, so three of its eight reds (c21,
-- c23, c24) were about the license_status term it silently dropped rather than
-- about 'agent' being a writer role.
--
-- One red that SURVIVES the rebase and is worth reading carefully: c22. With
-- 'agent' a writer, u_agent_gone -- who is still an ACTIVE member of org B --
-- becomes a writer there and so reads org B's agreement row. C22's first
-- assertion is an unqualified count, so it sees that. The row read is not their
-- own; the control's message says "anywhere" for exactly this reason.
CREATE OR REPLACE FUNCTION public.can_write_split_agreements(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.organization_members m
                        WHERE m.organization_id = p_org_id AND m.user_id = (SELECT auth.uid())
                          AND m.role IN ('agent','broker','admin')
                          AND m.license_status = 'active'); $fn$;
DO $m$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE oid='public.can_write_split_agreements(uuid)'::regprocedure;
  IF position('''agent''' in src) = 0 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;
  IF position('license_status' in src) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the status term went with it'; END IF;
  IF position('m.organization_id = p_org_id' in src) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the org term went with it'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: agent added to the writer role list -- an agent can set their own split';
