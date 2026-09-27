-- C06: the policy's existing conditions still hold on an otherwise-valid
-- desktop insert.
--   submitted_by naming another member of the same org          -> RLS
--   T1's agent into T2 (not a member)                           -> RLS
--   personal agent I into their own personal organization       -> RLS
-- Wrong implementations this catches: the submitter term dropped (m09), the
-- personal-organization term dropped (m10).
DO $c06$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  agent2 uuid := pg_temp.id('u_t1_agent2');
  u_i    uuid := pg_temp.id('u_i');
  o_t1   uuid := pg_temp.id('o_t1');
  o_t2   uuid := pg_temp.id('o_t2');
  o_i    uuid := pg_temp.id('o_i');
BEGIN
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C06 submitted_by another user',
    pg_temp.desk('00000000-0000-4000-8000-000035470601', o_t1, agent2, 'fixture-3547-c06-1', '''uploading'''), 'RLS'); -- pii-allow-uuid: invented fixture id
  PERFORM pg_temp.expect('C06 other organization',
    pg_temp.desk('00000000-0000-4000-8000-000035470602', o_t2, agent, 'fixture-3547-c06-2', '''uploading'''), 'RLS'); -- pii-allow-uuid: invented fixture id
  PERFORM pg_temp.act_as(u_i);
  PERFORM pg_temp.expect('C06 personal organization',
    pg_temp.desk('00000000-0000-4000-8000-000035470603', o_i, u_i, 'fixture-3547-c06-3', '''uploading'''), 'RLS'); -- pii-allow-uuid: invented fixture id
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT count(*) FROM public.organization_members WHERE user_id = u_i AND organization_id = o_i) = 1,
                        'C06 personal agent IS a member of the personal org (so the refusal is the personal-org term)');
END
$c06$;
