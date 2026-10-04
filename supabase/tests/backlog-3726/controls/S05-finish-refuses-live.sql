-- finish deletes none of: submitted; uploading not abandoned; forced submitted + abandoned.
-- The forced row is never listed by claim.
DO $$ DECLARE c uuid; a uuid; z uuid; r jsonb; f jsonb;
BEGIN
  c := pg_temp.sub('submitted', '30 hours'); a := pg_temp.sub('uploading', '1 hour');
  z := pg_temp.sub('submitted', '30 hours', '2 hours');
  r := pg_temp.claim(false);
  f := pg_temp.finish(r, ARRAY[c, a, z]);
  PERFORM pg_temp.ok((f->>'rows_deleted')::int = 0, 'S05 finish deletes no live or unabandoned row');
  PERFORM pg_temp.ok(NOT (z::text = ANY (pg_temp.ids(r))), 'S05 submitted+abandoned never listed');
END $$;
