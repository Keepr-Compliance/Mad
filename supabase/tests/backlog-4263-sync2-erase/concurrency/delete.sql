-- /*t:delete*/ Deletes the fixture user by its exact id and this run's exact email; every other row cascades.
SET LOCAL lock_timeout = '3s';
DELETE FROM auth.users WHERE id = '__U__'::uuid AND email = 'p4263c-__RUN__@example.test';
