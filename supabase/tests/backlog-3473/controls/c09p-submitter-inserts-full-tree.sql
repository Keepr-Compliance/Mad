-- C9p (SR condition K1): the submitter CAN insert the whole copy tree while
-- the submission is uploading -- the one path BACKLOG-3477 needs.
-- As u_t1_agent on S_up (T1, uploading, entitled):
--   header                                  : rows:1
--   item                                    : rows:1
--   attachment link, member -> A1           : rows:1, rows:1
--   email link, member -> M1 (email)        : rows:1, rows:1
-- Then, as the owner, S_up holds 1 / 1 / 2 / 2 rows.
-- Mutants: m15a..d (that table's INSERT policy WITH CHECK (false) -> RLS),
--          m51a..d (that table's INSERT grant revoked -> PRIV).

SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('C9p header',
  format('INSERT INTO public.submission_checklists (id, submission_id, template_name) VALUES (%L, %L, %L)',
         '00000000-0000-4000-8000-00003473e301', pg_temp.id('s_up'), 'Fixture starter A'), 'rows:1'); -- pii-allow-uuid: invented fixture id
SELECT pg_temp.expect('C9p item',
  format('INSERT INTO public.submission_checklist_items (id, submission_id, submission_checklist_id, title, is_required, is_checked, note, sort_order) VALUES (%L, %L, %L, %L, true, true, %L, 10)',
         '00000000-0000-4000-8000-00003473e302', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e301', 'Fixture item A1', 'c09p note'), 'rows:1'); -- pii-allow-uuid: invented fixture ids
SELECT pg_temp.expect('C9p attachment link',
  format('INSERT INTO public.submission_checklist_links (id, submission_id, submission_checklist_item_id, kind, label, sort_order) VALUES (%L, %L, %L, %L, %L, 10)',
         '00000000-0000-4000-8000-00003473e303', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e302', 'attachment', 'fixture-a1.pdf'), 'rows:1'); -- pii-allow-uuid: invented fixture ids
SELECT pg_temp.expect('C9p attachment member',
  format('INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_attachment_id) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e303', 'attachment', pg_temp.id('a1')), 'rows:1'); -- pii-allow-uuid: invented fixture id
SELECT pg_temp.expect('C9p email link',
  format('INSERT INTO public.submission_checklist_links (id, submission_id, submission_checklist_item_id, kind, label, sort_order) VALUES (%L, %L, %L, %L, %L, 20)',
         '00000000-0000-4000-8000-00003473e304', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e302', 'email', 'Fixture thread'), 'rows:1'); -- pii-allow-uuid: invented fixture ids
SELECT pg_temp.expect('C9p email member',
  format('INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_message_id) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e304', 'email', pg_temp.id('m1')), 'rows:1'); -- pii-allow-uuid: invented fixture id
SELECT pg_temp.act_owner();

DO $post$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES ('public.submission_checklists', 1), ('public.submission_checklist_items', 1),
                                 ('public.submission_checklist_links', 2), ('public.submission_checklist_link_members', 2)) v(tbl, want) LOOP
    PERFORM pg_temp.check(pg_temp.n(format('SELECT count(*) FROM %s WHERE submission_id = %L', t.tbl, pg_temp.id('s_up'))) = t.want,
                          format('owner re-read: S_up holds %s row(s) in %s', t.want, t.tbl));
  END LOOP;
END
$post$;
