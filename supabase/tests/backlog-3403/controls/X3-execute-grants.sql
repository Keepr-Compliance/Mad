-- X3: anon has no EXECUTE on the two RPCs and no read of attempts; authenticated has EXECUTE
SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public.finalize_submission(uuid,jsonb)', 'EXECUTE'), 'X3 anon finalize');
SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public.record_submission_attempt(uuid,uuid,text,text,text,integer,jsonb,boolean,text,text)', 'EXECUTE'), 'X3 anon record');
SELECT pg_temp.ok(has_function_privilege('authenticated', 'public.finalize_submission(uuid,jsonb)', 'EXECUTE'), 'X3 authenticated finalize');
SELECT pg_temp.ok(has_function_privilege('authenticated', 'public.record_submission_attempt(uuid,uuid,text,text,text,integer,jsonb,boolean,text,text)', 'EXECUTE'), 'X3 authenticated record');
SELECT pg_temp.ok(NOT has_table_privilege('anon', 'public.submission_attempts', 'SELECT'), 'X3 anon cannot read attempts');
