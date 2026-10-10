-- harness: rollback
-- C8: the rollback restores the production CHECK, defaults and function body
-- (the md5 equals production's, which also proves the transcription).
SELECT pg_temp.want('c8 CHECK restored', pg_temp.type_check_def(), pg_temp.prod_check_def());
SELECT pg_temp.want('c8 defaults restored', pg_temp.defaults(), pg_temp.prod_defaults());
SELECT pg_temp.want('c8 function body restored (production md5)', pg_temp.fn_md5(), pg_temp.prod_md5());
SELECT pg_temp.want('c8 ACL/secdef/search_path unchanged', pg_temp.fn_acl(), pg_temp.prod_acl());
SELECT pg_temp.want('c8 trial accepted again by the RPC (old behaviour)',
  pg_temp.run_as('authenticated', pg_temp.id('u_admin'),
    'SELECT public.admin_update_license(''{l_ind}'', ''{"license_type":"trial"}''::jsonb)'), 'OK rows=1');
