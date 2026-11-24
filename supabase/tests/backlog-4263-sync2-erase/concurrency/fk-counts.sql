-- /*t:fkcount*/ READ ONLY. For every column that references auth.users (read from the catalogue now, not a hand
-- list), the number of rows holding the fixture user id, and the column's ON DELETE action (del: a = no action,
-- c = cascade, n = set null, d = set default, r = restrict). Counts only. Rows in an n / d column stay behind after
-- the delete with the id cleared, so run.sh counts them as left behind. Rows reached only through a second table's
-- cascade (a deal's messages and files) are counted by residue.sql, not here.
SELECT json_build_object('tag', 'fkcount', 'fk', coalesce((SELECT json_agg(json_build_object('tbl', f.tbl, 'col', f.col, 'del', f.del, 'n', f.n) ORDER BY f.tbl, f.col) FROM (
  SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col, c.confdeltype::text AS del,
         (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s WHERE %I = %L::uuid',
                                                     c.conrelid::regclass, a.attname, '__U__'), false, true, '')))[1]::text::bigint AS n
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass) f), '[]'::json)) AS a;
