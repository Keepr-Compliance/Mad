-- /*t:fkcount*/ READ ONLY. For every column that references auth.users (read from the catalogue now, not a hand
-- list), the number of rows holding the fixture user id. Counts only. Rows reached only through a second table's
-- cascade (a deal's messages and files) are counted by residue.sql, not here.
SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col,
       (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s WHERE %I = %L::uuid',
                                                   c.conrelid::regclass, a.attname, '__U__'), false, true, '')))[1]::text::bigint AS n
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
 WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass
 ORDER BY 1, 2;
