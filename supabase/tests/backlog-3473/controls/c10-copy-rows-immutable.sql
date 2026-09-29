-- C10 (Addendum B R6): copy rows can never be UPDATEd or DELETEd by a client.
-- The submitter of S_fin, on each of the 4 copy tables:
--   UPDATE ... WHERE submission_id = S_fin     : PRIV
--   DELETE ... WHERE submission_id = S_fin     : PRIV
-- Then, as the owner, S_fin still holds 1 / 1 / 2 / 2 rows with their values.
-- A forgotten REVOKE with Supabase's default grants would give rows:0
-- (FILTERED) instead -- PRIV refuses to accept that.
-- Mutants: m17a..d (UPDATE, DELETE granted + submitter policies on that table).

SELECT pg_temp.act_as(pg_temp.id('u_t1_agent'));
DO $c10$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('public.submission_checklists', 'template_name = ''c10'''),
    ('public.submission_checklist_items', 'is_checked = NOT is_checked'),
    ('public.submission_checklist_links', 'label = ''c10'''),
    ('public.submission_checklist_link_members', 'submission_attachment_id = submission_attachment_id')
  ) v(tbl, set_clause) LOOP
    PERFORM pg_temp.expect('C10 UPDATE ' || t.tbl,
      format('UPDATE %s SET %s WHERE submission_id = %L', t.tbl, t.set_clause, pg_temp.id('s_fin')), 'PRIV');
    PERFORM pg_temp.expect('C10 DELETE ' || t.tbl,
      format('DELETE FROM %s WHERE submission_id = %L', t.tbl, pg_temp.id('s_fin')), 'PRIV');
  END LOOP;
END
$c10$;
SELECT pg_temp.act_owner();

DO $post$
BEGIN
  PERFORM pg_temp.check((SELECT template_name FROM public.submission_checklists WHERE id = pg_temp.id('h_fin')) = 'Fixture starter A',
                        'header unchanged');
  PERFORM pg_temp.check((SELECT is_checked FROM public.submission_checklist_items WHERE id = pg_temp.id('i_fin')) IS TRUE,
                        'item unchanged');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_links WHERE submission_id = pg_temp.id('s_fin')
                           AND label IN ('fixture-a4.pdf', 'Fixture thread')) = 2,
                        'links present, labels unchanged');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_link_members WHERE submission_id = pg_temp.id('s_fin')) = 2,
                        'members present');
END
$post$;
