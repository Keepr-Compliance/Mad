-- READ ONLY (cleanup mode): is the user with the fixture id this run's fixture user, and the auth.users total.
SELECT json_build_object('tag', 'own',
       'n', (SELECT count(*) FROM auth.users WHERE id = '__U__'::uuid AND email IS DISTINCT FROM 'p4263c-__RUN__@example.test'),
       'mine', (SELECT count(*) FROM auth.users WHERE id = '__U__'::uuid), 'total', (SELECT count(*) FROM auth.users)) AS a;
