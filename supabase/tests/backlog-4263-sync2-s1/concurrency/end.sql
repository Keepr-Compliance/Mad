-- session 2 answer (one tagged json): the function's result and the database clock after the gate and after the call.
SELECT json_build_object('tag', 'session', 'r', current_setting('p4263.r')::jsonb, 't_start', current_setting('p4263.t_start'),
                         't_end', clock_timestamp()) AS a;
