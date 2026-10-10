-- harness: drift
-- C9: if admin_update_license's body is neither production's nor this
-- migration's, the migration aborts before changing anything.
SELECT pg_temp.want('c9 migration refused the drifted body',
  (SELECT coalesce(err, '<no error>') FROM t3857_err), '~^3857 pre-check: admin_update_license body differs');
SELECT pg_temp.want('c9 CHECK unchanged', pg_temp.type_check_def(), pg_temp.prod_check_def());
SELECT pg_temp.want('c9 defaults unchanged', pg_temp.defaults(), pg_temp.prod_defaults());
