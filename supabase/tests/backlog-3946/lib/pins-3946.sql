-- BACKLOG-3946: after the 3917 + 3938 + 3940 layering, every helper and every policy that
-- calls one must equal production (lib/catalog-3946.sql), else ERROR. Also loaded again at
-- the end of the rollback stack (controls/r04) to prove all three rollbacks restore production.
DO $pin$ DECLARE bad text; BEGIN
  SELECT string_agg(coalesce(p.k, v.k)||' prod='||coalesce(p.v,'<none>')||' venue='||coalesce(v.v,'<none>'), E'\n') INTO bad
    FROM pg_temp.prod3946() p FULL JOIN pg_temp.venue3946() v ON v.k = p.k WHERE p.v IS DISTINCT FROM v.v;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'PINS3946 MISMATCH:%', E'\n'||bad; END IF;
END $pin$;
SELECT 'PINS3946 OK';
