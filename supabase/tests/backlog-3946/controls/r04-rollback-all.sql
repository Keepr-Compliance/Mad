-- R04: A + B + C applied, then all three rollbacks and lib/pins-3946.sql again (the stack
-- raises PINS3946 MISMATCH unless every pin equals production). Plus links grants.
DO $$ DECLARE s text; BEGIN
  s := pg_temp.links_grants3946();
  PERFORM pg_temp.check('r04 links grants equal production', s = 'anon:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE authenticated:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE', s);
  SELECT count(*)::text INTO s FROM pg_temp.prod3946() p FULL JOIN pg_temp.venue3946() v USING (k) WHERE p.v IS DISTINCT FROM v.v;
  PERFORM pg_temp.check('r04 every pin equals production', s = '0', s);
END $$;
