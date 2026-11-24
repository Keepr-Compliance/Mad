-- last call of every run: reset the statement statistics of the test database (Disk IO budget).
SELECT extensions.pg_stat_statements_reset();
SELECT json_build_object('tag', 'reset', 'ok', true) AS a;
