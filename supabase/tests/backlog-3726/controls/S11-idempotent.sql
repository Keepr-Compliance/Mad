DO $$ DECLARE b uuid; r1 jsonb; r2 jsonb; f1 jsonb; f2 jsonb;
BEGIN
  b := pg_temp.sub('uploading', '90 minutes', '70 minutes'); PERFORM pg_temp.att(b, 'a.pdf');
  r1 := pg_temp.claim(false); r2 := pg_temp.claim(false);
  PERFORM pg_temp.ok(b::text = ANY (pg_temp.ids(r1)) AND b::text = ANY (pg_temp.ids(r2)), 'S11 a crashed run is listed again by the next run');
  PERFORM pg_temp.rm(pg_temp.allpaths(r2)); PERFORM pg_temp.rm(pg_temp.allpaths(r2));
  f1 := pg_temp.finish(r2, ARRAY[b]); f2 := pg_temp.finish(r2, ARRAY[b]);
  PERFORM pg_temp.ok((f1->>'rows_deleted')::int = 1 AND (f2->>'rows_deleted')::int = 0, 'S11 repeat finish is a no-op');
END $$;
