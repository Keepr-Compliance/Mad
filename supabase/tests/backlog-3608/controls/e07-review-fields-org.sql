-- E07: the reviewer check reads the row's CURRENT organization. A submitter
-- that is a broker in another organization moves its row there and sets the
-- review fields to itself in one statement -> 'review_fields_reviewer_only'.
DO $e07$
DECLARE
  x uuid := pg_temp.id('u_t2_broker');
  v uuid;
BEGIN
  v := pg_temp.mk_sub('fixture-3608-e07', 1, NULL, 'uploading', x, pg_temp.id('o_t1'));
  PERFORM pg_temp.act_as(x);
  PERFORM pg_temp.expect('E07-G1 submitter moves row to an org it reviews and names itself',
    format($q$UPDATE public.transaction_submissions SET organization_id=%L, reviewed_by=%L, review_notes='ok' WHERE id=%L$q$, pg_temp.id('o_t2'), x, v),
    '~^42501:review_fields_reviewer_only$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT organization_id = pg_temp.id('o_t1') AND reviewed_by IS NULL FROM public.transaction_submissions WHERE id = v),
                        'E07 row unchanged');
END
$e07$;
