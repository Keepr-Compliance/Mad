-- e11: at submit, the agent's own template set not to be sent is skipped;
-- the agent's own sent template and brokerage templates are kept. Flipping
-- the switch takes effect at the next version, and the version diff records it.
DO $e11$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  s uuid; x uuid; v1 uuid; v2 uuid; res jsonb; pay jsonb;
BEGIN
  s := pg_temp.tpl3618('o_t1', agent, 'Own sent', true);
  x := pg_temp.tpl3618('o_t1', agent, 'Own not sent', false);
  pay := pg_temp.base_payload() || jsonb_build_array(pg_temp.one_cl(s, 'Own sent', 2), pg_temp.one_cl(x, 'Own not sent', 3));

  v1 := pg_temp.mk_sub('fixture-3618-e11', 1, NULL, 'uploading');
  PERFORM pg_temp.mk_uploads(v1, pg_temp.v1_att(), pg_temp.v_msg());
  res := pg_temp.snap_as(agent, v1, pay);
  PERFORM pg_temp.set_status(v1, 'submitted');
  PERFORM pg_temp.check((res ->> 'checklists')::int = 3, 'e11a v1 wrote 3 checklists: ' || res::text);
  PERFORM pg_temp.check(pg_temp.hdr(v1, 'Own not sent') IS NULL, 'e11b v1 skipped the excluded own template');
  PERFORM pg_temp.check(pg_temp.hdr(v1, 'Own sent') IS NOT NULL, 'e11c v1 kept the included own template');
  PERFORM pg_temp.check(pg_temp.hdr(v1, 'Fixture starter A') IS NOT NULL AND pg_temp.hdr(v1, 'Fixture custom B') IS NOT NULL,
                        'e11d v1 kept the brokerage template and the no-template checklist');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.submission_checklist_items WHERE submission_id = v1 AND title = 'Own not sent item'),
                        'e11e no item of the excluded checklist');

  UPDATE public.checklist_templates SET include_in_submission = false WHERE id = s;
  UPDATE public.checklist_templates SET include_in_submission = true WHERE id = x;
  v2 := pg_temp.new_version(v1, 2);
  res := pg_temp.snap_as(agent, v2, pay);
  PERFORM pg_temp.check((res ->> 'checklists')::int = 3, 'e11f v2 wrote 3 checklists: ' || res::text);
  PERFORM pg_temp.check(pg_temp.hdr(v2, 'Own sent') IS NULL AND pg_temp.hdr(v2, 'Own not sent') IS NOT NULL, 'e11g v2 follows the flipped switches');
  PERFORM pg_temp.check(pg_temp.vd(v2) LIKE '%checklist_removed:Own sent%' AND pg_temp.vd(v2) LIKE '%checklist_added:Own not sent%',
                        'e11h version diff records both: ' || pg_temp.vd(v2));
  PERFORM pg_temp.check(pg_temp.hdr(v1, 'Own sent') IS NOT NULL, 'e11i v1 copy untouched');
END
$e11$;
