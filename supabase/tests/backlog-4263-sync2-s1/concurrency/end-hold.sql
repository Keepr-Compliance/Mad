-- session 1 answer: the function's result and the database clock at start, after the call, and after the hold.
-- The hold's locks are released only after this statement, so a session 2 that waited for them ends after t_end.
SELECT current_setting('p4263.r')::jsonb AS r, current_setting('p4263.t_start') AS t_start,
       current_setting('p4263.t_hold') AS t_hold, clock_timestamp() AS t_end;
