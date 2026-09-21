-- C10b (Addendum B R6): OBSERVED behaviour, recorded, not a gate. "Frozen"
-- means immutable rows, not a closed set: a submitter who re-opens a
-- needs_changes submission can add copy rows again. The looseness is
-- BACKLOG-3497. If 3497 tightens the status transition, the first step turns
-- to rows:0 and this file is rewritten -- it is not "fixed" by loosening
-- anything here. No mutant.
-- As u_t1_agent (submitter of S_nc, which holds a header and one item):
--   UPDATE S_nc status needs_changes -> uploading     : rows:1
--   INSERT an item under S_nc's existing header       : rows:1
--   INSERT a second header on S_nc                    : UNQ (UNIQUE (submission_id))

SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('C10b re-open S_nc',
  format('UPDATE public.transaction_submissions SET status = %L WHERE id = %L', 'uploading', pg_temp.id('s_nc')), 'rows:1');
SELECT pg_temp.expect('C10b item under the existing header',
  format('INSERT INTO public.submission_checklist_items (submission_id, submission_checklist_id, title, is_required) VALUES (%L, %L, %L, false)',
         pg_temp.id('s_nc'), pg_temp.id('h_nc'), 'c10b added'), 'rows:1');
SELECT pg_temp.expect('C10b second header',
  format('INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (%L, %L)', pg_temp.id('s_nc'), 'c10b'), 'UNQ');
SELECT pg_temp.act_owner();
