-- e10 (SR C1, X01): add at review and an agent's private template.
--   a  Undo of a removed private checklist on the version that carries it -> readded
--   b  the same private template on another deal                        -> template_not_found
--   c  positive: a brokerage template on that deal                        -> added
DO $e10$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent'); broker uuid := pg_temp.id('u_t1_broker');
  p uuid; b uuid; v1 uuid; v2 uuid; hp uuid; res jsonb;
BEGIN
  p := pg_temp.tpl3618('o_t1', agent, 'Agent private P');
  b := pg_temp.tpl3618('o_t1', NULL, 'Brokerage extra');
  v1 := pg_temp.build_v1('fixture-3618-e10a', pg_temp.base_payload() || jsonb_build_array(pg_temp.one_cl(p, 'Agent private P', 2)));
  PERFORM pg_temp.set_status(v1, 'under_review');
  hp := pg_temp.hdr(v1, 'Agent private P');
  PERFORM pg_temp.check(hp IS NOT NULL AND (SELECT template_id FROM public.submission_checklists WHERE id = hp) = p, 'e10 v1 carries P');
  PERFORM pg_temp.act_as(broker);
  res := public.add_submission_checklist_at_review(v1, p);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(res ->> 'status' = 'exists', 'e10 P present -> exists: ' || res::text);
  res := pg_temp.remove_as(broker, hp);
  PERFORM pg_temp.check(res ->> 'status' = 'removed', 'e10 broker removed P: ' || res::text);
  PERFORM pg_temp.act_as(broker);
  res := public.add_submission_checklist_at_review(v1, p);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(res ->> 'status' = 'readded', 'e10a broker Undo of the removed private checklist: ' || res::text);
  PERFORM pg_temp.check((SELECT removed_at_review_by IS NULL FROM public.submission_checklists WHERE id = hp), 'e10a header un-removed');

  v2 := pg_temp.build_v1('fixture-3618-e10b');
  PERFORM pg_temp.set_status(v2, 'under_review');
  PERFORM pg_temp.act_as(broker);
  res := public.add_submission_checklist_at_review(v2, p);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(res ->> 'status' = 'template_not_found', 'e10b broker adds private P to another deal: ' || res::text);
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.submission_checklists WHERE submission_id = v2 AND template_id = p), 'e10b nothing written');
  PERFORM pg_temp.act_as(broker);
  res := public.add_submission_checklist_at_review(v2, b);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(res ->> 'status' = 'added', 'e10c positive: brokerage template added: ' || res::text);
END
$e10$;
