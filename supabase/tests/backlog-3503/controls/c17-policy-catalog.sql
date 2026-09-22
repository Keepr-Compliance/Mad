-- C17: the catalog assertions that NO behavioural control can reach.
--
-- Why this control exists: the INSERT policy's member-EXISTS clause must compare
-- m.organization_id to the NEW ROW's organization_id. Written unqualified it binds
-- to m.organization_id and Postgres stores `m.organization_id = m.organization_id`
-- -- measured. That is vacuously true, but today it changes NO behaviour, because
-- organization_members carries its own RLS (`organization_id IN
-- get_user_org_ids(auth.uid())`) which already hides other orgs' members. The two
-- mistakes cancel, so every behavioural control stays green.
-- It is not safe to leave uncovered: the same organization_members policy also
-- admits `has_internal_role(auth.uid())`, and an internal-role caller sees EVERY
-- membership row -- for whom the vacuous form WOULD be a real cross-org write.
DO $$
DECLARE wc text; q text; cfg text[];
BEGIN
  -- can_write_commission_agreements is the migration's ONLY SECURITY DEFINER
  -- object. Dropping `SET search_path = public` from a definer function lets the
  -- caller choose the schema its body resolves in; nothing behavioural in this
  -- harness can see that, so it is asserted from the catalog.
  SELECT prosecdef::text, proconfig INTO wc, cfg FROM pg_proc
   WHERE oid = 'public.can_write_commission_agreements(uuid)'::regprocedure;
  PERFORM pg_temp.check(wc = 'true', format('the write rule is SECURITY DEFINER, got %s', wc));
  PERFORM pg_temp.check(cfg @> ARRAY['search_path=public'],
    format('the write rule pins SET search_path = public, got %s', coalesce(cfg::text, 'NULL')));
  PERFORM pg_temp.check(
    (SELECT bool_and(NOT prosecdef) FROM pg_proc
      WHERE oid IN ('public.commission_agreement_in_force(uuid,uuid,date)'::regprocedure,
                    'public.franchise_fee_in_force(uuid,date)'::regprocedure)),
    'neither read helper is SECURITY DEFINER');

  SELECT with_check INTO wc FROM pg_policies
   WHERE tablename='agent_commission_agreements' AND policyname='agent_commission_agreements_insert_writer';
  PERFORM pg_temp.check(wc IS NOT NULL, 'the INSERT policy exists');
  PERFORM pg_temp.check(position('m.organization_id = agent_commission_agreements.organization_id' in wc) > 0,
                        format('the member check compares m.organization_id to the NEW ROW1s org, got: %s', wc));
  PERFORM pg_temp.check(position('m.organization_id = m.organization_id' in wc) = 0,
                        'the member check is not a self-comparison');
  -- the same class, swept over every policy this migration creates
  FOR q IN SELECT coalesce(qual,'') || ' ' || coalesce(with_check,'') FROM pg_policies
            WHERE tablename IN ('agent_commission_agreements','organization_franchise_fees')
  LOOP
    PERFORM pg_temp.check(q !~ '(\m[a-z_]+\.[a-z_]+) = \1', format('no policy contains a self-comparison: %s', q));
  END LOOP;
END $$;
