-- C24 (Addendum B R7, K8): the catalogue refuses any row the seed copy could
-- not copy. Owner INSERTs, each a separate seed_key:
--   element without title / title '' / title '   ' / title 301 chars /
--   is_required "yes" / expected_document_type "deed" / an unknown key /
--   items an object (K8: folded into the validator, one CHECK) /
--   an element that is a string / element description 2001 chars
--                                     : CHK naming checklist_seed_templates_items_check
--   name ''                           : CHK naming checklist_seed_templates_name_check
--   a valid row                       : rows:1
-- Mutants: m42 (items CHECK dropped), m43 (name CHECK dropped).
-- Recorded, not a gate: with m42 applied and a malformed row present, the next
-- team+ plan assignment raises from the seed trigger -- why the CHECK exists.

SELECT pg_temp.act_owner();
SELECT pg_temp.expect('C24 ' || v.label,
  format('INSERT INTO public.checklist_seed_templates (seed_key, name, items) VALUES (%L, %L, %L::jsonb)', v.seed_key, 'c24', v.items),
  '~^23514:.*checklist_seed_templates_items_check')
FROM (VALUES
  ('element without title', 'zz_c24_01', '[{"description": null}]'),
  ('title empty',           'zz_c24_02', '[{"title": ""}]'),
  ('title blank',           'zz_c24_03', '[{"title": "   "}]'),
  ('title 301 chars',       'zz_c24_04', '[{"title": "' || repeat('x', 301) || '"}]'),
  ('is_required a string',  'zz_c24_05', '[{"title": "x", "is_required": "yes"}]'),
  ('unknown document type', 'zz_c24_06', '[{"title": "x", "expected_document_type": "deed"}]'),
  ('unknown key',           'zz_c24_07', '[{"title": "x", "is_requried": true}]'),
  ('items an object',       'zz_c24_08', '{"title": "x"}'),
  ('element a string',      'zz_c24_09', '["x"]'),
  ('description 2001',      'zz_c24_10', '[{"title": "x", "description": "' || repeat('d', 2001) || '"}]')
) v(label, seed_key, items);

SELECT pg_temp.expect('C24 name empty',
  'INSERT INTO public.checklist_seed_templates (seed_key, name, items) VALUES (''zz_c24_11'', '''', ''[]''::jsonb)',
  '~^23514:.*checklist_seed_templates_name_check');
SELECT pg_temp.expect('C24 a valid row',
  'INSERT INTO public.checklist_seed_templates (seed_key, name, items) VALUES (''zz_c24_12'', ''c24 valid'', ''[{"title": "x", "description": null, "is_required": null, "expected_document_type": "title"}, {"title": "' || repeat('y', 300) || '"}]''::jsonb)',
  'rows:1');
