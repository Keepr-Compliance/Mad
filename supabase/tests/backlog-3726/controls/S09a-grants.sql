DO $$ BEGIN
  PERFORM pg_temp.ok(NOT has_function_privilege('authenticated', 'public.submission_sweep_claim(boolean,interval,interval,interval,integer,integer)', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.submission_sweep_claim(boolean,interval,interval,interval,integer,integer)', 'EXECUTE'), 'S09a claim: no client EXECUTE');
  PERFORM pg_temp.ok(NOT has_function_privilege('authenticated', 'public.submission_sweep_finish(uuid,uuid[],jsonb,text)', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.submission_sweep_finish(uuid,uuid[],jsonb,text)', 'EXECUTE'), 'S09a finish: no client EXECUTE');
  PERFORM pg_temp.ok(NOT has_function_privilege('authenticated', 'public.submission_sweep_secret()', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.submission_sweep_secret()', 'EXECUTE'), 'S09a secret: no client EXECUTE');
  PERFORM pg_temp.ok(NOT has_function_privilege('authenticated', 'public.submission_sweep_invoke()', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.submission_sweep_invoke()', 'EXECUTE')
                 AND NOT has_function_privilege('service_role', 'public.submission_sweep_invoke()', 'EXECUTE'), 'S09a invoke: no EXECUTE for any API role');
  PERFORM pg_temp.ok(has_function_privilege('service_role', 'public.submission_sweep_claim(boolean,interval,interval,interval,integer,integer)', 'EXECUTE')
                 AND has_function_privilege('service_role', 'public.submission_sweep_finish(uuid,uuid[],jsonb,text)', 'EXECUTE')
                 AND has_function_privilege('service_role', 'public.submission_sweep_secret()', 'EXECUTE'), 'S09a service_role can run claim, finish, secret');
END $$;
