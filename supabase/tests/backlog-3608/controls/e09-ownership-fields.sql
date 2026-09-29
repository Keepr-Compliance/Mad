-- E09: a client statement cannot change id, organization_id, submitted_by,
-- local_transaction_id, parent_submission_id or version
-- ('submission_owner_fields_locked'), one column at a time:
--   the submitter on its own uploading row (organization_id to an org it is
--     not in, and to an org it belongs to);
--   a broker of two organizations on an open row (organization_id to its
--     other org, and every other column).
-- A status-only update of the same rows still succeeds.
DO $e09$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  y     uuid := pg_temp.id('u_y');        -- broker in T1 and in E
  xu    uuid := pg_temp.id('u_x');        -- broker in T1, agent in E
  v uuid; v0 uuid; w uuid; wx uuid; c record;
  locked text := '~^42501:submission_owner_fields_locked$';
BEGIN
  v0 := pg_temp.mk_sub('fixture-3608-e09-0', 1, NULL, 'approved');
  v  := pg_temp.mk_sub('fixture-3608-e09', 1, NULL, 'uploading');
  w  := pg_temp.mk_sub('fixture-3608-e09-w', 1, NULL, 'submitted');
  wx := pg_temp.mk_sub('fixture-3608-e09-x', 1, NULL, 'uploading', xu, pg_temp.id('o_t1'));
  FOR c IN SELECT * FROM (VALUES
      ('id',                   quote_literal(gen_random_uuid())),
      ('organization_id',      quote_literal(pg_temp.id('o_t2'))),
      ('submitted_by',         quote_literal(pg_temp.id('u_t1_agent2'))),
      ('local_transaction_id', quote_literal('fixture-3608-e09-moved')),
      ('parent_submission_id', quote_literal(v0)),
      ('version',              '2')) t(col, val) LOOP
    PERFORM pg_temp.act_as(agent);
    PERFORM pg_temp.expect('E09 submitter changes ' || c.col,
      format('UPDATE public.transaction_submissions SET %I = %s WHERE id = %L', c.col, c.val, v), locked);
    PERFORM pg_temp.act_as(y);
    PERFORM pg_temp.expect('E09 broker changes ' || c.col,
      format('UPDATE public.transaction_submissions SET %I = %s WHERE id = %L', c.col,
             CASE WHEN c.col = 'organization_id' THEN quote_literal(pg_temp.id('o_e')) ELSE c.val END, w), locked);
    PERFORM pg_temp.act_owner();
  END LOOP;
  PERFORM pg_temp.act_as(xu);
  PERFORM pg_temp.expect('E09 submitter moves its row to an org it belongs to',
    format('UPDATE public.transaction_submissions SET organization_id = %L WHERE id = %L', pg_temp.id('o_e'), wx), locked);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT count(*) FROM public.transaction_submissions
                          WHERE (id = v AND organization_id = pg_temp.id('o_t1') AND submitted_by = agent AND local_transaction_id = 'fixture-3608-e09'
                                 AND parent_submission_id IS NULL AND version = 1)
                             OR (id = w AND organization_id = pg_temp.id('o_t1') AND version = 1)
                             OR (id = wx AND organization_id = pg_temp.id('o_t1'))) = 3,
                        'E09 rows unchanged');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E09 submitter status-only update', format($q$UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = %L$q$, v), 'rows:1');
  PERFORM pg_temp.act_as(y);
  PERFORM pg_temp.expect('E09 broker status-only update', format($q$UPDATE public.transaction_submissions SET status = 'under_review' WHERE id = %L$q$, w), 'rows:1');
  PERFORM pg_temp.act_owner();
END
$e09$;
