-- /*t:authcount*/ READ ONLY: the auth.users total, compared with the precheck's total after the teardown.
SELECT count(*) AS n FROM auth.users;
