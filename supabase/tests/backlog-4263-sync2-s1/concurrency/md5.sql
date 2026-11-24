-- READ ONLY: md5 of the mutant copy's body (no body = the create failed).
SELECT json_build_object('tag', 'md5', 'm', (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.__MUTANT_SIG__'))) AS a;
