-- C02 (A-C2): a snapshot that fails anywhere writes nothing. Three payloads,
-- each valid until its LAST element:
--   (a) the last link has kind 'bogus'                -> 22023 invalid_payload
--   (b) the last item has no title                    -> 23502
--   (c) the last checklist repeats the first template -> 23505
-- After each, S_up holds exactly the fixture rows (1 header, 1 item, 0, 0).
-- Wrong implementation this catches: an unknown kind silently skipped.
DO $c02$
DECLARE
  good jsonb := jsonb_build_object('template_id', pg_temp.id('tpl_t1_a'), 'template_name', 'Fixture starter A',
    'items', jsonb_build_array(jsonb_build_object('title', 'Fixture item A1', 'is_required', true,
      'links', jsonb_build_array(jsonb_build_object('kind', 'attachment', 'label', 'a', 'local_ids', jsonb_build_array('fixture-3477-local-a'))))));
  bad_kind jsonb := jsonb_build_array(good, jsonb_build_object('template_name', 'Second',
    'items', jsonb_build_array(jsonb_build_object('title', 'x',
      'links', jsonb_build_array(jsonb_build_object('kind', 'attachment', 'label', 'ok', 'local_ids', jsonb_build_array('fixture-3477-local-b')),
                                 jsonb_build_object('kind', 'bogus', 'label', 'bad', 'local_ids', jsonb_build_array('fixture-3477-local-b')))))));
  bad_title jsonb := jsonb_build_array(good, jsonb_build_object('template_name', 'Second',
    'items', jsonb_build_array(jsonb_build_object('title', 'x'), jsonb_build_object('is_required', true))));
  dup_template jsonb := jsonb_build_array(good, good);
  s uuid := pg_temp.id('s_up');
  t record;
BEGIN
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_agent'));
  PERFORM pg_temp.expect('C02a bad kind', format('SELECT public.snapshot_submission_checklists(%L, %L::jsonb)', s, bad_kind), '~^22023:invalid_payload');
  PERFORM pg_temp.expect('C02b no title', format('SELECT public.snapshot_submission_checklists(%L, %L::jsonb)', s, bad_title), '~^23502:');
  PERFORM pg_temp.expect('C02c same template twice', format('SELECT public.snapshot_submission_checklists(%L, %L::jsonb)', s, dup_template), 'UNQ');
  PERFORM pg_temp.act_owner();
  FOR t IN SELECT * FROM (VALUES ('public.submission_checklists', 1), ('public.submission_checklist_items', 1),
                                 ('public.submission_checklist_links', 0), ('public.submission_checklist_link_members', 0)) v(tbl, want) LOOP
    PERFORM pg_temp.check(pg_temp.n(format('SELECT count(*) FROM %s WHERE submission_id = %L', t.tbl, s)) = t.want,
                          format('C02 S_up still holds %s row(s) in %s', t.want, t.tbl));
  END LOOP;
END
$c02$;
