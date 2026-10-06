-- D12 (C-8): the remove and restore RPCs take FOR UPDATE on the submission
-- row. That lock conflicts with the KEY SHARE the next version's insert takes
-- through its parent_submission_id FK, so the removal / restore and the next
-- version are serialized. FOR NO KEY UPDATE (or none) would not conflict.
DO $d12$
DECLARE s text;
BEGIN
  SELECT prosrc INTO s FROM pg_proc WHERE proname = 'remove_submission_checklist_at_review' AND pronamespace = 'public'::regnamespace;
  PERFORM pg_temp.check(s ~ 'FROM public\.transaction_submissions ts\s+WHERE ts\.id = v_hdr\.submission_id\s+FOR UPDATE;',
                        'D12 remove locks the submission FOR UPDATE');
  PERFORM pg_temp.check(s !~* 'NO KEY', 'D12 remove: no NO KEY lock');
  SELECT prosrc INTO s FROM pg_proc WHERE proname = 'restore_submission_checklist_at_review' AND pronamespace = 'public'::regnamespace;
  PERFORM pg_temp.check(s ~ 'FROM public\.transaction_submissions ts\s+WHERE ts\.id = p_submission_id\s+FOR UPDATE;',
                        'D12 restore locks the submission FOR UPDATE');
  PERFORM pg_temp.check(s !~* 'NO KEY', 'D12 restore: no NO KEY lock');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_submissions_parent_submission_id_fkey'),
                        'D12 the parent FK that takes KEY SHARE exists');
END
$d12$;
