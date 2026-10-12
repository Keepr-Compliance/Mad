-- Control (2b) + parity: every corpus entry, in all three resolvers and in
-- _override_effective directly. Malformed -> override ignored (plan answer),
-- never an exception. Same corpus file as the parsePaidThrough jest test.
DO $c$
DECLARE c jsonb; r record; want text; eff text;
BEGIN
  FOR c IN SELECT jsonb_array_elements(current_setting('t3845.corpus')::jsonb -> 'cases') LOOP
    PERFORM pg_temp.set_override(pg_temp.porg('u_live'), 'unlimited_transactions', c -> 'override');
    want := CASE WHEN (c ->> 'entitled')::boolean THEN 'OK true/override' ELSE 'OK false/plan' END;
    FOR r IN SELECT * FROM pg_temp.resolve3(pg_temp.id('u_live'), pg_temp.porg('u_live'), 'unlimited_transactions') LOOP
      PERFORM pg_temp.check('corpus ' || (c ->> 'name') || ' [' || r.resolver || ']', r.answer = want,
                            'got ' || r.answer || ', want ' || want);
    END LOOP;
    IF to_regprocedure('public._override_effective(jsonb)') IS NOT NULL THEN
      eff := pg_temp.try(format('SELECT public._override_effective(%L::jsonb)::text', c -> 'override'));
      PERFORM pg_temp.check('corpus ' || (c ->> 'name') || ' [_override_effective]',
                            eff = 'OK ' || (c ->> 'entitled'), 'got ' || eff);
    ELSE
      PERFORM pg_temp.check('corpus ' || (c ->> 'name') || ' [_override_effective]', false, 'function absent');
    END IF;
  END LOOP;
  -- Non-object overrides: `->` on a scalar is NULL -> treated as absent paid_through (today's behaviour).
  eff := pg_temp.try('SELECT public._override_effective(''true''::jsonb)::text');
  PERFORM pg_temp.check('scalar override -> effective (unchanged behaviour)', eff = 'OK true', eff);
END $c$;
