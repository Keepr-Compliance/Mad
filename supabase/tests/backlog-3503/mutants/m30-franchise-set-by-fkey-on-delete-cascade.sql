-- The same inversion on the franchise table's audit key. Isolates the franchise
-- half of C19: deleting the broker now takes the office's fee history with him.
ALTER TABLE public.organization_franchise_fees DROP CONSTRAINT organization_franchise_fees_set_by_fkey;
ALTER TABLE public.organization_franchise_fees
  ADD CONSTRAINT organization_franchise_fees_set_by_fkey
  FOREIGN KEY (set_by) REFERENCES public.users(id) ON DELETE CASCADE;
DO $m$ BEGIN
  IF (SELECT confdeltype FROM pg_constraint WHERE conname = 'organization_franchise_fees_set_by_fkey') <> 'c'
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: franchise set_by foreign key rewritten ON DELETE CASCADE';
