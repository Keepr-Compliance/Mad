-- Files removed, then finish: row gone, children cascaded, attempt row abandoned, run row closed.
DO $$ DECLARE b uuid; r jsonb; f jsonb;
BEGIN
  b := pg_temp.sub('uploading', '3 hours'); PERFORM pg_temp.att(b, 'a.pdf');
  INSERT INTO submission_messages (submission_id, channel) VALUES (b, 'sms');
  INSERT INTO submission_attempts (submission_id, user_id, organization_id) VALUES (b, pg_temp.agent(), pg_temp.org1());
  r := pg_temp.claim(false);
  PERFORM pg_temp.rm(pg_temp.allpaths(r));
  f := pg_temp.finish(r, ARRAY[b], 'ok', '{"objects_removed": 1}');
  PERFORM pg_temp.ok((f->>'rows_deleted')::int = 1, 'S03 row deleted after its files');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM submission_messages WHERE submission_id = b)
                 AND NOT EXISTS (SELECT 1 FROM submission_attachments WHERE submission_id = b), 'S03 children cascaded');
  PERFORM pg_temp.ok((SELECT outcome = 'abandoned' AND stage = 'server_sweep' FROM submission_attempts WHERE submission_id = b), 'S03 attempt row abandoned');
  PERFORM pg_temp.ok((SELECT outcome = 'ok' AND ended_at IS NOT NULL AND (counts->>'rows_deleted')::int = 1 AND (counts->>'objects_removed')::int = 1
                        FROM submission_sweep_runs WHERE id = (r->>'run_id')::uuid), 'S03 run row closed with counts');
END $$;
