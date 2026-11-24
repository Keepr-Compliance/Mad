-- session 1 answer (one tagged json): the function's result and the database clock at start, after the call, and after
-- the hold. The hold's locks are released only after this statement, so a session 2 that waited for them ends after t_end.
SELECT json_build_object('tag', 'session', 'r', current_setting('p4263.r')::jsonb, 't_start', current_setting('p4263.t_start'),
                         't_hold', current_setting('p4263.t_hold'), 't_end', clock_timestamp()) AS a;
