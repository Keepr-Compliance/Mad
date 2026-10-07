-- SR X1: an abandoned row's attachment row (H1 bypassed) names a LIVE submission's object. Never listed.
DO $$ DECLARE b uuid; c uuid; pc text; r jsonb;
BEGIN
  c := pg_temp.sub('submitted', '30 hours'); pc := pg_temp.att(c, 'live.pdf');
  b := pg_temp.sub('uploading', '3 hours', '2 hours');
  ALTER TABLE submission_attachments DISABLE ROW LEVEL SECURITY;
  INSERT INTO submission_attachments (submission_id, filename, storage_path) VALUES (b, 'live.pdf', pc);
  ALTER TABLE submission_attachments ENABLE ROW LEVEL SECURITY;
  r := pg_temp.claim(false);
  PERFORM pg_temp.ok(b::text = ANY (pg_temp.ids(r)), 'X1 the abandoned row is listed');
  PERFORM pg_temp.ok(NOT (pc = ANY (pg_temp.paths(r, b))), 'X1 a live submission''s object is never in a sweep path list');
END $$;
