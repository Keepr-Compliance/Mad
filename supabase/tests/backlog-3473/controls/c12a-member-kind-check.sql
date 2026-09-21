-- C12a (Addendum B R4): a member's target column must match its kind.
-- Setup as the owner on S_up: header, item, email link.
-- As u_t1_agent: an `email` member with submission_attachment_id = A1 and no
-- message id, under the email link                                   : CHK
--   RLS passes (submitter, uploading; A1 is S_up's; no message id, so the
--   channel term is not reached); the composite FK passes (kinds equal).
-- Mutant: m20 (submission_checklist_link_members_target_check dropped).

SELECT pg_temp.act_owner();
INSERT INTO public.submission_checklists (id, submission_id, template_name) VALUES
  ('00000000-0000-4000-8000-00003473e401', pg_temp.id('s_up'), 'Fixture starter A'); -- pii-allow-uuid: invented fixture id
INSERT INTO public.submission_checklist_items (id, submission_id, submission_checklist_id, title, is_required) VALUES
  ('00000000-0000-4000-8000-00003473e402', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e401', 'Fixture item A1', true); -- pii-allow-uuid: invented fixture ids
INSERT INTO public.submission_checklist_links (id, submission_id, submission_checklist_item_id, kind, label) VALUES
  ('00000000-0000-4000-8000-00003473e404', pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e402', 'email', 'Fixture thread'); -- pii-allow-uuid: invented fixture ids

SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
SELECT pg_temp.expect('C12a email member carrying an attachment id',
  format('INSERT INTO public.submission_checklist_link_members (submission_id, link_id, kind, submission_attachment_id) VALUES (%L, %L, %L, %L)',
         pg_temp.id('s_up'), '00000000-0000-4000-8000-00003473e404', 'email', pg_temp.id('a1')), 'CHK'); -- pii-allow-uuid: invented fixture id
SELECT pg_temp.act_owner();
