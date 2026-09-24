-- C28 (BACKLOG-3474): the create path (p_template_id NULL).
--   valid create                       -> ok; org, created_by, sort_order = max+10,
--                                         items 10/20, token = stored
--   last item fails its CHECK          -> 23514 and ZERO new templates (A4)
--   an element carries an id           -> P0001 item_mismatch, no new template
--   the expected token is ignored      -> a garbage token still creates
-- Mutant: m56 (item INSERT wrapped in EXCEPTION WHEN OTHERS THEN RETURN).

SELECT pg_temp.act_owner();

DO $c28$
DECLARE
  org     uuid := pg_temp.id('o_t1');
  before  bigint := (SELECT count(*) FROM public.checklist_templates WHERE organization_id = pg_temp.id('o_t1'));
  maxsort integer := (SELECT max(sort_order) FROM public.checklist_templates WHERE organization_id = pg_temp.id('o_t1'));
  res     text;
  tpl     uuid;
BEGIN
  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), org, NULL, 'not a timestamp', ' c28 new ', NULL,
           '[{"title": "c28 a", "is_required": true, "expected_document_type": "offer"}, {"title": "c28 b"}]'::jsonb);
  PERFORM pg_temp.check(res LIKE 'ok:%', format('C28 create ok, got %s', res));
  tpl := split_part(substr(res, 4), '|', 1)::uuid;
  PERFORM pg_temp.check((SELECT organization_id = org AND created_by = pg_temp.id('u_t1_broker') AND name = 'c28 new'
                                AND sort_order = coalesce(maxsort, 0) + 10 AND archived_at IS NULL AND seed_key IS NULL
                           FROM public.checklist_templates WHERE id = tpl),
                        'C28 row: org, created_by, trimmed name, sort_order max+10, active, not seeded');
  PERFORM pg_temp.check(pg_temp.t3474_shape(tpl) = 'c28 a:true:offer:10|c28 b:false:-:20', format('C28 items, got %s', pg_temp.t3474_shape(tpl)));
  PERFORM pg_temp.check(pg_temp.t3474_tok(res) = pg_temp.t3474_token(tpl), 'C28 returned token = stored');

  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), org, NULL, NULL, 'c28 bad', NULL,
           '[{"title": "c28 fine"}, {"title": "c28 fine too"}, {"title": ""}]'::jsonb);
  PERFORM pg_temp.check(res LIKE '23514:%', format('C28 bad create raised 23514, got %s', res));
  PERFORM pg_temp.check((SELECT count(*) FROM public.checklist_templates WHERE organization_id = org) = before + 1,
                        'C28 failed create left zero new templates');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_templates WHERE name = 'c28 bad'), 'C28 no c28 bad row');

  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), org, NULL, NULL, 'c28 with id', NULL,
           jsonb_build_array(jsonb_build_object('id', pg_temp.id('item_t1_a1'), 'title', 'c28 steal')));
  PERFORM pg_temp.check(res = 'P0001:item_mismatch', format('C28 id on create refused, got %s', res));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.checklist_templates WHERE name = 'c28 with id'), 'C28 no c28 with id row');
  PERFORM pg_temp.check((SELECT title FROM public.checklist_template_items WHERE id = pg_temp.id('item_t1_a1')) = 'Fixture item A1',
                        'C28 foreign item untouched');
END
$c28$;
