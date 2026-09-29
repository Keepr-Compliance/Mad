-- C13 (Addendum B R4): a child's submission_id must equal its parent's.
-- Run as the owner: the venue's postgres has BYPASSRLS (the gate records
-- role:postgres_rolbypassrls), so RLS is out of the way and only the
-- composite foreign keys can refuse.
--   item with submission_id = S_sub under S_fin's header          : FK
--   link with submission_id = S_sub under S_fin's item             : FK
--   member with submission_id = S_sub under S_fin's attachment link,
--     kind attachment, target A3 (exists)                          : FK
-- Mutants: m22a / m22b / m22c (that table's composite FK -> single-column FK
-- on the parent id).

SELECT pg_temp.act_owner();
SELECT pg_temp.expect('C13 item under another submission''s header',
  format('INSERT INTO public.submission_checklist_items (submission_id, submission_checklist_id, title, is_required) VALUES (%L, %L, %L, false)',
         pg_temp.id('s_sub'), pg_temp.id('h_fin'), 'c13'), 'FK');
SELECT pg_temp.expect('C13 link under another submission''s item',
  format('INSERT INTO public.submission_checklist_links (submission_id, submission_checklist_item_id, kind, label) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_sub'), pg_temp.id('i_fin'), 'attachment', 'c13'), 'FK');
SELECT pg_temp.expect('C13 member under another submission''s link',
  format('INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_attachment_id) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_sub'), pg_temp.id('l_fin_a'), 'attachment', pg_temp.id('a3')), 'FK');
