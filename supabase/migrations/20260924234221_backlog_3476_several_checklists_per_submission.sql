-- BACKLOG-3476: a submission may carry several checklists. The table has no
-- rows yet, so this changes no data.

-- One checklist per submission is no longer the rule.
ALTER TABLE public.submission_checklists
  DROP CONSTRAINT IF EXISTS submission_checklists_submission_id_key;

-- The dropped constraint's index was the only index led by submission_id.
-- The cascade from transaction_submissions and every RLS policy filter on it.
CREATE INDEX IF NOT EXISTS submission_checklists_submission_id_idx
  ON public.submission_checklists (submission_id);

-- Display order of a submission's checklists: the agent's order is kept
-- everywhere they are shown.
ALTER TABLE public.submission_checklists
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

-- The broker template a checklist was copied from. Provenance only: nullable,
-- no foreign key and no constraint.
ALTER TABLE public.submission_checklists
  ADD COLUMN IF NOT EXISTS template_id uuid;
