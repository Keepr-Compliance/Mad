-- The deactivation trigger written THE OBVIOUS WAY: no `UPDATE OF
-- license_status`, no WHEN clause, and a body that tests the NEW VALUE instead
-- of the transition.
--
-- This is the most likely WRONG implementation of section 2b, and it is the one
-- a later "simplification" produces: the guards look like noise, and the naive
-- form reads as obviously equivalent. It is not. Every write that leaves a row
-- at 'suspended' now RE-STAMPS deactivated_at with the current time:
--   * supabase/functions/scim/handlers/users.ts:824-831 writes 'suspended'
--     UNCONDITIONALLY in the DELETE handler, without reading the current value;
--   * SCIM and directory-sync both bump scim_synced_at on rows that may already
--     be suspended.
-- Each such write moves the end of the active period FORWARD, which silently
-- re-admits exactly the agreement the founder's rule refuses -- an agreement
-- dated after the agent left becomes legal the next time anything touches their
-- row.
--
-- The damage is invisible inside one transaction, because now() is constant for
-- its whole duration: re-stamping writes the same instant it already held. C26
-- defeats that by setting an explicit PAST date first, as postgres, so the
-- re-stamp has something visibly different to overwrite.
--
-- Everything else in the trigger is left exactly as shipped -- it still fires
-- BEFORE UPDATE, still on this table, still per row, and still clears the column
-- on a move to 'active' -- so this mutant's RED set is evidence about the
-- transition guards and nothing else.
DROP TRIGGER org_members_track_deactivation ON public.organization_members;
CREATE OR REPLACE FUNCTION public.set_org_member_deactivated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  IF NEW.license_status = 'suspended' THEN
    NEW.deactivated_at := now();
  ELSIF NEW.license_status = 'active' THEN
    NEW.deactivated_at := NULL;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER org_members_track_deactivation
  BEFORE UPDATE ON public.organization_members
  FOR EACH ROW
  EXECUTE FUNCTION public.set_org_member_deactivated_at();
DO $m$
DECLARE d text;
BEGIN
  SELECT pg_get_triggerdef(t.oid) INTO d FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'organization_members'
     AND t.tgname  = 'org_members_track_deactivation';
  IF d IS NULL THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: no such trigger'; END IF;
  IF position('WHEN' in d) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the WHEN transition guard survived'; END IF;
  IF position('UPDATE OF' in d) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the UPDATE OF column list survived'; END IF;
  -- and the rest is intact: a mutant that also moved the timing or the table
  -- would red for a different reason.
  IF position('BEFORE UPDATE' in d) = 0
   OR position('FOR EACH ROW' in d) = 0
   OR position('set_org_member_deactivated_at' in d) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: something else moved too'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: the deactivation trigger no longer tests the TRANSITION -- any update leaving a row suspended re-stamps the date';
