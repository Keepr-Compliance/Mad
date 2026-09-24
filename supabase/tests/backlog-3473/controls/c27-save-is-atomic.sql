-- C27 (BACKLOG-3474): a save that fails on its LAST item changes nothing.
-- The payload also renames the template, edits item 1, removes item 3 and adds
-- a valid item before the failing one. Three failing last items:
--   title blank after trim     -> 23514 (title CHECK)
--   document type 'lease'      -> 23514 (type CHECK)
--   description of 2001 chars  -> 23514 (description CHECK)
-- Each time: the call raised, the name, token and every item are unchanged,
-- and the removed item still exists.
-- Mutant: m56 (new-item INSERT wrapped in EXCEPTION WHEN OTHERS THEN RETURN).

SELECT pg_temp.act_owner();
SELECT set_config('t3474.tpl', pg_temp.t3474_template(pg_temp.id('o_t1'), 'c27 template', 3)::text, true) IS NOT NULL;

DO $c27$
DECLARE
  tpl     uuid := current_setting('t3474.tpl')::uuid;
  i1      jsonb := pg_temp.t3474_item(current_setting('t3474.tpl')::uuid, 1);
  i2      jsonb := pg_temp.t3474_item(current_setting('t3474.tpl')::uuid, 2);
  i3id    uuid := (pg_temp.t3474_item(current_setting('t3474.tpl')::uuid, 3)->>'id')::uuid;
  shape0  text := pg_temp.t3474_shape(current_setting('t3474.tpl')::uuid);
  head0   text := pg_temp.t3474_head(current_setting('t3474.tpl')::uuid);
  bad     jsonb;
  res     text;
BEGIN
  FOREACH bad IN ARRAY ARRAY[
    '{"title": "   "}'::jsonb,
    '{"title": "c27 bad type", "expected_document_type": "lease"}'::jsonb,
    jsonb_build_object('title', 'c27 long description', 'description', repeat('d', 2001))
  ] LOOP
    res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), tpl, current_setting('t3474.token0'),
             'c27 renamed', 'c27 description',
             jsonb_build_array(i1 || '{"title": "c27 edited"}'::jsonb, i2, '{"title": "c27 valid new"}'::jsonb, bad));
    PERFORM pg_temp.check(res LIKE '23514:%', format('C27 raised 23514 for %s, got %s', bad, res));
    PERFORM pg_temp.check(pg_temp.t3474_shape(tpl) = shape0, format('C27 items unchanged, got %s', pg_temp.t3474_shape(tpl)));
    PERFORM pg_temp.check(pg_temp.t3474_head(tpl) = head0, format('C27 name/token unchanged, got %s', pg_temp.t3474_head(tpl)));
    PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.checklist_template_items WHERE id = i3id), 'C27 removed item still exists');
  END LOOP;
END
$c27$;
