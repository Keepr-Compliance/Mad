-- C35 (BACKLOG-3474, A8 + A9): only an editor of p_org_id, with the feature,
-- saves; everyone else gets 42501 not_authorized (not the stale message) and
-- nothing changes. All calls run as `authenticated` with JWT claims.
--   T1 agent on a T1 template                        -> 42501 not_authorized
--   T2 broker (feature off) on T2's template          -> 42501
--   T2 broker creating in T2                          -> 42501
--   T1 broker creating with p_org_id = E              -> 42501
--   T1/E member u_x (broker in T1, agent in E) in E   -> 42501
--   non-member                                        -> 42501
--   T1 broker, p_org_id = T1, E's template + its token -> P0001 stale_or_not_found
-- Mutants: m52 (up-front authority check removed), m53 (that removal AND
-- SECURITY DEFINER). m54 (SECURITY DEFINER alone) leaves this GREEN: the
-- up-front check still refuses; c34 is its red (see README).

SELECT pg_temp.act_owner();
SELECT set_config('t3474.tpl', pg_temp.t3474_template(pg_temp.id('o_t1'), 'c35 template', 2)::text, true) IS NOT NULL;

DO $c35$
DECLARE
  tpl     uuid := current_setting('t3474.tpl')::uuid;
  items   jsonb := pg_temp.t3474_items(current_setting('t3474.tpl')::uuid);
  shape0  text := pg_temp.t3474_shape(current_setting('t3474.tpl')::uuid);
  head0   text := pg_temp.t3474_head(current_setting('t3474.tpl')::uuid);
  t2      uuid := pg_temp.id('tpl_t2_a');
  t2head  text := pg_temp.t3474_head(pg_temp.id('tpl_t2_a'));
  t2shape text := pg_temp.t3474_shape(pg_temp.id('tpl_t2_a'));
  ea      uuid := pg_temp.id('tpl_e_a');
  ehead   text := pg_temp.t3474_head(pg_temp.id('tpl_e_a'));
  n_all   bigint := (SELECT count(*) FROM public.checklist_templates);
  one     jsonb := '[{"title": "c35 x"}]'::jsonb;
  res     text;
BEGIN
  PERFORM pg_temp.check(t2 IS NOT NULL AND ea IS NOT NULL, 'C35 fixtures give T2 and E seeded templates');

  res := pg_temp.t3474_save(pg_temp.id('u_t1_agent'), pg_temp.id('o_t1'), tpl, current_setting('t3474.token0'), 'c35 agent', NULL,
           jsonb_build_array(items->1, items->0));
  PERFORM pg_temp.check(res = '42501:not_authorized', format('C35 agent refused, got %s', res));
  PERFORM pg_temp.check(pg_temp.t3474_shape(tpl) = shape0 AND pg_temp.t3474_head(tpl) = head0, 'C35 agent changed nothing');

  res := pg_temp.t3474_save(pg_temp.id('u_t2_broker'), pg_temp.id('o_t2'), t2, pg_temp.t3474_token(t2), 'c35 t2', NULL,
           pg_temp.t3474_items(t2));
  PERFORM pg_temp.check(res = '42501:not_authorized', format('C35 feature-off broker refused, got %s', res));
  PERFORM pg_temp.check(pg_temp.t3474_head(t2) = t2head AND pg_temp.t3474_shape(t2) = t2shape, 'C35 T2 template unchanged');

  res := pg_temp.t3474_save(pg_temp.id('u_t2_broker'), pg_temp.id('o_t2'), NULL, NULL, 'c35 t2 new', NULL, one);
  PERFORM pg_temp.check(res = '42501:not_authorized', format('C35 feature-off create refused, got %s', res));

  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_e'), NULL, NULL, 'c35 cross org', NULL, one);
  PERFORM pg_temp.check(res = '42501:not_authorized', format('C35 create in another org refused, got %s', res));

  res := pg_temp.t3474_save(pg_temp.id('u_x'), pg_temp.id('o_e'), NULL, NULL, 'c35 u_x in E', NULL, one);
  PERFORM pg_temp.check(res = '42501:not_authorized', format('C35 agent-in-E (editor elsewhere) refused, got %s', res));

  res := pg_temp.t3474_save(pg_temp.id('u_outsider'), pg_temp.id('o_t1'), NULL, NULL, 'c35 outsider', NULL, one);
  PERFORM pg_temp.check(res = '42501:not_authorized', format('C35 non-member refused, got %s', res));

  res := pg_temp.t3474_save(pg_temp.id('u_t1_broker'), pg_temp.id('o_t1'), ea, pg_temp.t3474_token(ea), 'c35 steal E', NULL, one);
  PERFORM pg_temp.check(res = 'P0001:stale_or_not_found', format('C35 other org''s template under own org refused, got %s', res));
  PERFORM pg_temp.check(pg_temp.t3474_head(ea) = ehead, 'C35 E template unchanged');

  PERFORM pg_temp.check((SELECT count(*) FROM public.checklist_templates) = n_all, 'C35 no template created by any refused call');
END
$c35$;
