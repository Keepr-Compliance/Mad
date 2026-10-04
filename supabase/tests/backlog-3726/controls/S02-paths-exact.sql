-- Paths = the row's attachment rows + rowless objects in its own {org}/{id}/ folder; nothing else.
DO $$ DECLARE b uuid; o uuid; p1 text; p2 text; p3 text; r jsonb;
BEGIN
  b := pg_temp.sub('uploading', '3 hours'); o := pg_temp.sub('uploading', '10 minutes');
  p1 := pg_temp.att(b, 'a.pdf'); p2 := pg_temp.att(b, 'b.pdf');
  p3 := pg_temp.obj(pg_temp.org1() || '/' || b || '/x.jpg');                 -- 2.38-style object, no row
  PERFORM pg_temp.att(o, 'other.pdf');                                       -- another submission
  PERFORM pg_temp.obj(pg_temp.org2() || '/' || b || '/wrong-org.pdf');        -- seg 2 = b, other org
  r := pg_temp.claim(false);
  PERFORM pg_temp.ok(pg_temp.paths(r, b) = (SELECT array_agg(v ORDER BY v) FROM unnest(ARRAY[p1, p2, p3]) v), 'S02 paths = its 2 rows + its rowless object');
END $$;
