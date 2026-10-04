-- finish keeps only snake_case keys with numbers: a path string or a nested object never lands in the run row.
DO $$ DECLARE r jsonb; c jsonb;
BEGIN
  r := pg_temp.claim(true);
  PERFORM pg_temp.finish(r, '{}', 'ok', jsonb_build_object('objects_removed', 3, 'path', 'org/sub/file.pdf', 'Bad-Key', 1, 'nested', jsonb_build_object('a', 1)));
  SELECT counts INTO c FROM submission_sweep_runs WHERE id = (r->>'run_id')::uuid;
  PERFORM pg_temp.ok((c->>'objects_removed')::int = 3, 'S14 numeric count kept');
  PERFORM pg_temp.ok(NOT (c ? 'path') AND NOT (c ? 'Bad-Key') AND NOT (c ? 'nested'), 'S14 string, bad key and nested value dropped');
END $$;
