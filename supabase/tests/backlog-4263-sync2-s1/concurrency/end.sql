-- session 2 answer: the function's result and the database clock after the gate and after the call.
SELECT current_setting('p4263.r')::jsonb AS r, current_setting('p4263.t_start') AS t_start, clock_timestamp() AS t_end;
