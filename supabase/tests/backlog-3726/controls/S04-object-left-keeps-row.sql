-- One removal failed: the object is still there, so the row stays (retried next run).
DO $$ DECLARE b uuid; r jsonb; f jsonb; p1 text;
BEGIN
  b := pg_temp.sub('uploading', '3 hours'); p1 := pg_temp.att(b, 'a.pdf'); PERFORM pg_temp.att(b, 'b.pdf');
  r := pg_temp.claim(false);
  PERFORM pg_temp.rm(jsonb_build_array(p1));
  f := pg_temp.finish(r, ARRAY[b], 'partial');
  PERFORM pg_temp.ok((f->>'rows_deleted')::int = 0 AND (f->>'rows_kept')::int = 1, 'S04 row kept while an object remains');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM transaction_submissions WHERE id = b), 'S04 parent still there');
END $$;
