-- READ ONLY (cleanup mode): is the user with the fixture id this run's fixture user, and the auth.users total.
SELECT json_build_object('tag', 'own',
       'n', (SELECT count(*) FROM auth.users WHERE id = '__A__'::uuid AND email IS DISTINCT FROM 'p4263s1cc-__RUN__@example.test'),
       'mine', (SELECT count(*) FROM auth.users WHERE id = '__A__'::uuid), 'total', (SELECT count(*) FROM auth.users)) AS a;
