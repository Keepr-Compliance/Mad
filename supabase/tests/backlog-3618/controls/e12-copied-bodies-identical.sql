-- e12: the two re-created bodies are the production bodies plus exactly one
-- inserted hunk each (lib/hunks-3618.sql). Removing the hunk gives back the
-- production md5; the hunk occurs exactly once; header properties unchanged.
SELECT pg_temp.check(position(current_setting('t3618.snap_hunk') IN p.prosrc) > 0
         AND length(p.prosrc) - length(replace(p.prosrc, current_setting('t3618.snap_hunk'), '')) = length(current_setting('t3618.snap_hunk')),
         'e12a snapshot: the hunk occurs exactly once')
  FROM pg_proc p WHERE p.oid = 'public.snapshot_submission_checklists(uuid,jsonb)'::regprocedure;
SELECT pg_temp.check(md5(replace(p.prosrc, current_setting('t3618.snap_hunk'), '')) = '029af8d2b14ebed58b760552c116d133',
         'e12b snapshot minus the hunk = production md5, got ' || md5(replace(p.prosrc, current_setting('t3618.snap_hunk'), '')))
  FROM pg_proc p WHERE p.oid = 'public.snapshot_submission_checklists(uuid,jsonb)'::regprocedure;
SELECT pg_temp.check(position(current_setting('t3618.add_hunk') IN p.prosrc) > 0
         AND length(p.prosrc) - length(replace(p.prosrc, current_setting('t3618.add_hunk'), '')) = length(current_setting('t3618.add_hunk')),
         'e12c add-at-review: the hunk occurs exactly once')
  FROM pg_proc p WHERE p.oid = 'public.add_submission_checklist_at_review(uuid,uuid)'::regprocedure;
SELECT pg_temp.check(md5(replace(p.prosrc, current_setting('t3618.add_hunk'), '')) = '42fbc9657bdf4226cad82748d57e3acc',
         'e12d add-at-review minus the hunk = production md5, got ' || md5(replace(p.prosrc, current_setting('t3618.add_hunk'), '')))
  FROM pg_proc p WHERE p.oid = 'public.add_submission_checklist_at_review(uuid,uuid)'::regprocedure;
SELECT pg_temp.check(md5(p.prosrc) <> '029af8d2b14ebed58b760552c116d133', 'e12e snapshot body did change')
  FROM pg_proc p WHERE p.oid = 'public.snapshot_submission_checklists(uuid,jsonb)'::regprocedure;
SELECT pg_temp.check(
  (SELECT split_part(v, ' ', 2) || ' ' || split_part(v, ' ', 3) || ' ' || split_part(v, ' ', 4) FROM pg_temp.fp3618() WHERE k = 'fn:snapshot_submission_checklists(uuid,jsonb)')
  = (SELECT split_part(v, ' ', 2) || ' ' || split_part(v, ' ', 3) || ' ' || split_part(v, ' ', 4) FROM t3618_before WHERE k = 'fn:snapshot_submission_checklists(uuid,jsonb)'),
  'e12f snapshot: security, search_path and ACL unchanged');
SELECT pg_temp.check(
  (SELECT split_part(v, ' ', 2) || ' ' || split_part(v, ' ', 3) || ' ' || split_part(v, ' ', 4) FROM pg_temp.fp3618() WHERE k = 'fn:add_submission_checklist_at_review(uuid,uuid)')
  = (SELECT split_part(v, ' ', 2) || ' ' || split_part(v, ' ', 3) || ' ' || split_part(v, ' ', 4) FROM t3618_before WHERE k = 'fn:add_submission_checklist_at_review(uuid,uuid)'),
  'e12g add-at-review: security, search_path and ACL unchanged');
