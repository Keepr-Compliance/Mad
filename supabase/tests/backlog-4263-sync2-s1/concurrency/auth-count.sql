-- /*t:authcount*/ READ ONLY: the auth.users total, compared with the precheck's total after the teardown.
SELECT json_build_object('tag', 'authcount', 'n', (SELECT count(*) FROM auth.users)) AS a;
