-- harness: apply-twice
-- e14: the 3618 file runs twice without error and the second run changes
-- nothing it fingerprints.
SELECT pg_temp.check(pg_temp.fp_diff('SELECT * FROM pg_temp.fp3618()', 'SELECT * FROM t3618_once') = '',
       'e14 second apply changed: ' || pg_temp.fp_diff('SELECT * FROM pg_temp.fp3618()', 'SELECT * FROM t3618_once'));
SELECT pg_temp.check((SELECT count(*) FROM pg_constraint WHERE conname = 'checklist_templates_include_owner_check') = 1, 'e14 one CHECK');
