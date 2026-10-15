-- harness: seed-trial
-- C6: with a 'trial' row present the migration aborts on its own pre-check
-- (not on the CHECK's 23514) and changes nothing.
SELECT pg_temp.want('c6 migration refused: pre-check names the trial row',
  (SELECT coalesce(err, '<no error>') FROM t3857_err), '~^3857 pre-check: 1 licenses row\(s\) have license_type trial$');
SELECT pg_temp.want('c6 CHECK unchanged', pg_temp.type_check_def(), pg_temp.prod_check_def());
SELECT pg_temp.want('c6 defaults unchanged', pg_temp.defaults(), pg_temp.prod_defaults());
SELECT pg_temp.want('c6 function unchanged', pg_temp.fn_md5(), pg_temp.prod_md5());
