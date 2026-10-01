-- e00: before the 3618 file, the venue's catalogue for everything the file
-- changes equals production (lib/fixtures-3618.sql prod3618, read 2026-09-30).
-- Every md5 claim in this harness rests on this control.
SELECT pg_temp.check(pg_temp.fp_diff('SELECT * FROM t3618_before', 'SELECT * FROM pg_temp.prod3618()') = '',
       'e00 prelude differs from production: ' || pg_temp.fp_diff('SELECT * FROM t3618_before', 'SELECT * FROM pg_temp.prod3618()'));
SELECT pg_temp.check((SELECT count(*) FROM t3618_before) = 9, 'e00 nine fingerprint keys before 3618');
