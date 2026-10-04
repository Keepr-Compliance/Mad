-- Boundary of the activity rule: newest object 1 h 50 min old -> not claimed; 2 h 10 min old -> claimed.
DO $$ DECLARE a uuid; b uuid; r jsonb;
BEGIN
  a := pg_temp.sub('uploading', '5 hours'); PERFORM pg_temp.obj(pg_temp.org1() || '/' || a || '/l/x.pdf', '1 hour 50 minutes');
  b := pg_temp.sub('uploading', '5 hours'); PERFORM pg_temp.obj(pg_temp.org1() || '/' || b || '/l/y.pdf', '2 hours 10 minutes');
  r := pg_temp.claim(false);
  PERFORM pg_temp.ok(NOT (a::text = ANY (pg_temp.ids(r))) AND (SELECT abandoned_at IS NULL FROM transaction_submissions WHERE id = a), 'S18 object 1h50m old: not claimed');
  PERFORM pg_temp.ok(b::text = ANY (pg_temp.ids(r)), 'S18 object 2h10m old: claimed');
END $$;
