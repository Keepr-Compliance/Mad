-- m03's mistake, on the OTHER table. m03 mutates split_agreement_in_force
-- alone; until F2/F3 existed in the fixture, this mutation reddened NOTHING
-- (SR's `msr02` probe, pm_comments 48fb9e71) -- the fee fixture had no
-- same-effective_from pair, so both orderings returned the same row.
--
-- `set_at` is transaction-start time and `seq` is allocated when the INSERT
-- executes, so a transaction that began earlier and wrote later has an EARLIER
-- set_at and a LATER seq. Ordering on set_at therefore returns the row the
-- broker wrote FIRST: the mistake instead of the correction.
CREATE OR REPLACE FUNCTION public.franchise_fee_in_force(
  p_organization_id uuid, p_on_date date DEFAULT current_date
) RETURNS SETOF public.organization_franchise_fees LANGUAGE sql STABLE SET search_path = public
AS $fn$ SELECT f.* FROM public.organization_franchise_fees f
   WHERE f.organization_id = p_organization_id AND f.effective_from <= p_on_date
   ORDER BY f.effective_from DESC, f.set_at DESC, f.seq DESC LIMIT 1; $fn$;
DO $m$ BEGIN
  IF position('set_at DESC' in (SELECT prosrc FROM pg_proc WHERE oid='public.franchise_fee_in_force(uuid,date)'::regprocedure)) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;
  -- the sibling helper is untouched, so a red here is about this table
  IF position('set_at' in (SELECT prosrc FROM pg_proc WHERE oid='public.split_agreement_in_force(uuid,uuid,date)'::regprocedure)) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the agreement helper changed too'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: franchise_fee_in_force orders by set_at DESC before seq DESC';
