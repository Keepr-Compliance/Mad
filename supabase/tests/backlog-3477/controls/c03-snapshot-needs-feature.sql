-- C03 (A-C3): no snapshot when the organization does not hold the feature.
-- As u_t2_agent on S_t2 (uploading, T2 lacks transaction_checklists):
-- the call and a direct header insert are refused (RLS); S_t2 holds no header.
-- Wrong implementations this catches: the header rule without the feature
-- term; the snapshot running as its owner (SECURITY DEFINER).
DO $c03$
DECLARE
  s uuid := pg_temp.id('s_t2');
  payload jsonb := jsonb_build_array(jsonb_build_object('template_name', 'Fixture starter A',
    'items', jsonb_build_array(jsonb_build_object('title', 'Fixture item A1'))));
BEGIN
  PERFORM pg_temp.act_as(pg_temp.id('u_t2_agent'));
  PERFORM pg_temp.expect('C03 snapshot refused', format('SELECT public.snapshot_submission_checklists(%L, %L::jsonb)', s, payload), 'RLS');
  PERFORM pg_temp.expect('C03 direct header refused',
    format('INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (%L, %L)', s, 'x'), 'RLS');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklists WHERE submission_id = s) = 0, 'C03 S_t2 holds no header');
END
$c03$;
