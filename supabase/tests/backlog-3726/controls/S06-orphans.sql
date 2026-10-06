-- (c) = rowless, no submission row at seg 2, older than 7 days (incl. a non-UUID seg 2).
-- A 2-day one is not. A rowless object in a submitted folder is counted, never listed.
DO $$ DECLARE c uuid; r jsonb; got text[]; o1 text; o2 text; o3 text; o4 text;
BEGIN
  c := pg_temp.sub('submitted', '30 days');
  o1 := pg_temp.obj(pg_temp.org1() || '/' || gen_random_uuid() || '/old.pdf', '8 days');
  o2 := pg_temp.obj(pg_temp.org1() || '/' || gen_random_uuid() || '/fresh.pdf', '2 days');
  o4 := pg_temp.obj(pg_temp.org1() || '/not-a-uuid/legacy.pdf', '9 days');
  o3 := pg_temp.obj(pg_temp.org1() || '/' || c || '/norow.pdf', '8 days');
  PERFORM pg_temp.att(c, 'kept.pdf', '20 days');
  r := pg_temp.claim(false);
  SELECT array_agg(v ORDER BY v) INTO got FROM jsonb_array_elements_text(r->'orphans') v;
  PERFORM pg_temp.ok(got = (SELECT array_agg(v ORDER BY v) FROM unnest(ARRAY[o1, o4]) v), 'S06 orphans = old no-parent + old non-UUID only');
  PERFORM pg_temp.ok((r->>'unreferenced_in_live_submissions')::int = 1, 'S06 rowless object in a submitted folder counted');
END $$;
