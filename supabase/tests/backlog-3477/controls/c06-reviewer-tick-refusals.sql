-- C06 (A-C6): who and when the tick is refused. Every refusal leaves I_req and
-- S_sub's history unchanged.
--   submitter (agent), another T1 agent, E's broker, no request JWT, the
--   service role, anon (no EXECUTE), unknown item          -> refused
--   T2's broker on T2's item (T2 lacks the feature)        -> not_authorized
--   approved, rejected, uploading                          -> not_open_for_review
--   p_checked NULL                                         -> 22023
-- Wrong implementations this catches: the helper admitting any member; the
-- status gate or the feature check left out.
DO $c06$
DECLARE
  q  text := format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.id('i_req'));
  n0 integer := jsonb_array_length(pg_temp.hist(pg_temp.id('s_sub')));
BEGIN
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_agent'));
  PERFORM pg_temp.expect('C06 submitter', q, '~^42501:not_authorized$');
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_agent2'));
  PERFORM pg_temp.expect('C06 another agent', q, '~^42501:not_authorized$');
  PERFORM pg_temp.act_as(pg_temp.id('u_e_broker'));
  PERFORM pg_temp.expect('C06 other org broker', q, '~^42501:not_authorized$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.expect('C06 no request JWT', q, '~^42501:not_authorized$');
  PERFORM pg_temp.act_service();
  PERFORM pg_temp.expect('C06 service role', q, '~^42501:');
  PERFORM pg_temp.act_anon();
  PERFORM pg_temp.expect('C06 anon', q, 'PRIV');
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_broker'));
  PERFORM pg_temp.expect('C06 unknown item',
    format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', '00000000-0000-4000-8000-00003477ffff'), '~^42501:not_authorized$'); -- pii-allow-uuid: invented fixture id
  PERFORM pg_temp.expect('C06 approved',
    format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.id('i_appr')), '~^42501:not_open_for_review$');
  PERFORM pg_temp.expect('C06 rejected',
    format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.id('i_rej')), '~^42501:not_open_for_review$');
  PERFORM pg_temp.expect('C06 uploading',
    format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.id('i_up')), '~^42501:not_open_for_review$');
  PERFORM pg_temp.expect('C06 NULL checked',
    format('SELECT public.set_submission_checklist_reviewer_check(%L, NULL)', pg_temp.id('i_req')), '~^22023:');
  PERFORM pg_temp.act_as(pg_temp.id('u_t2_broker'));
  PERFORM pg_temp.expect('C06 feature off (T2)',
    format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.id('i_t2')), '~^42501:not_authorized$');
  PERFORM pg_temp.act_owner();

  PERFORM pg_temp.check((SELECT NOT reviewer_checked FROM public.submission_checklist_items WHERE id = pg_temp.id('i_req')),
                        'C06 I_req unchanged');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(pg_temp.id('s_sub'))) = n0, 'C06 no entry appended');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_items
                          WHERE id IN (pg_temp.id('i_appr'), pg_temp.id('i_rej'), pg_temp.id('i_up'), pg_temp.id('i_t2'))
                            AND reviewer_checked) = 0, 'C06 refused items unchanged');
END
$c06$;
