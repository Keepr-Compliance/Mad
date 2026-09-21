-- C17 (Addendum B R10): seeding is idempotent per (organization, seed_key),
-- counted by templates AND items, as the owner.
--   after fixtures, T1/T2/E/C each hold 2 templates and 3 items
--   re-run the seed for T1                                       : returns 0; counts unchanged
--   T1 broker renames AND archives the zz_test_a copy            : rows:1
--   re-run                                                       : returns 0; the renamed,
--       archived copy untouched; no second zz_test_a copy (not resurrected)
--   add catalogue zz_test_d (2 items); re-run                    : returns 1; T1 gains
--       exactly 1 template and 2 items
-- Mutants: m33 (no ON CONFLICT -> UNQ on the first re-run), m34 (items for
-- every catalogue row, not only the inserted ones -> item count grows),
-- m35 (the partial unique index dropped -> ON CONFLICT has no arbiter).

SELECT pg_temp.act_owner();
CREATE FUNCTION pg_temp.c17_counts(p_org uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT (SELECT count(*) FROM public.checklist_templates WHERE organization_id = p_org) || '/' ||
         (SELECT count(*) FROM public.checklist_template_items i
            JOIN public.checklist_templates t ON t.id = i.template_id WHERE t.organization_id = p_org)
$$;

DO $c17a$
DECLARE
  o text;
BEGIN
  FOREACH o IN ARRAY ARRAY['o_t1', 'o_t2', 'o_e', 'o_c'] LOOP
    PERFORM pg_temp.check(pg_temp.c17_counts(pg_temp.id(o)) = '2/3', o || ' holds 2 templates / 3 items after fixtures');
  END LOOP;
  PERFORM pg_temp.check(public._seed_org_checklist_templates(pg_temp.id('o_t1')) = 0, 're-run 1 inserts 0 templates');
  PERFORM pg_temp.check(pg_temp.c17_counts(pg_temp.id('o_t1')) = '2/3', 're-run 1 leaves T1 at 2 / 3');
END
$c17a$;

SELECT pg_temp.act_as(pg_temp.id('u_t1_broker'));
SELECT pg_temp.expect('C17 broker renames and archives the seeded copy',
  format('UPDATE public.checklist_templates SET name = %L, archived_at = now() WHERE id = %L', 'c17 renamed', pg_temp.id('tpl_t1_a')), 'rows:1');
SELECT pg_temp.act_owner();

DO $c17b$
BEGIN
  PERFORM pg_temp.check(public._seed_org_checklist_templates(pg_temp.id('o_t1')) = 0, 're-run 2 inserts 0 templates');
  PERFORM pg_temp.check(pg_temp.c17_counts(pg_temp.id('o_t1')) = '2/3', 're-run 2 leaves T1 at 2 / 3');
  PERFORM pg_temp.check((SELECT name || '/' || (archived_at IS NOT NULL)::text FROM public.checklist_templates
                          WHERE id = pg_temp.id('tpl_t1_a')) = 'c17 renamed/true',
                        'the renamed, archived copy is untouched');
  PERFORM pg_temp.check((SELECT count(*) FROM public.checklist_templates
                          WHERE organization_id = pg_temp.id('o_t1') AND seed_key = 'zz_test_a') = 1,
                        'no second zz_test_a copy');

  INSERT INTO public.checklist_seed_templates (seed_key, name, sort_order, items) VALUES
    ('zz_test_d', 'Fixture starter D', 40, '[{"title": "Fixture item D1"}, {"title": "Fixture item D2", "is_required": true}]'::jsonb);
  PERFORM pg_temp.check(public._seed_org_checklist_templates(pg_temp.id('o_t1')) = 1, 're-run 3 inserts exactly 1 template');
  PERFORM pg_temp.check(pg_temp.c17_counts(pg_temp.id('o_t1')) = '3/5', 're-run 3 leaves T1 at 3 / 5');
  PERFORM pg_temp.check((SELECT string_agg(i.title || ':' || i.sort_order || ':' || i.is_required, ',' ORDER BY i.sort_order)
                           FROM public.checklist_template_items i JOIN public.checklist_templates t ON t.id = i.template_id
                          WHERE t.organization_id = pg_temp.id('o_t1') AND t.seed_key = 'zz_test_d')
                        = 'Fixture item D1:10:false,Fixture item D2:20:true',
                        'the new copy''s items carry sort_order = ordinality x 10 and is_required defaulting to false');
END
$c17b$;
