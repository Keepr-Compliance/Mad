-- The hold statement starts with the marker: a transport that submits statement by statement shows only the
-- current statement in pg_stat_activity.query. hold-marker.sql (first in the call) serves one that submits the call.
-- R1 session 1: IA writes a new deal, then holds its transaction (and its settings FOR SHARE lock) 4 s.
SELECT set_config('p4263.t_start', clock_timestamp()::text, true);
SELECT set_config('p4263.r', (public.__DEAL_FN__('__A__'::uuid, jsonb_build_object('source_install_id', '__IA__', 'local_id', 'r1-new', 'content_hash', encode(sha256('r1-new'::bytea), 'hex'))))::text, true);
SELECT set_config('p4263.t_hold', clock_timestamp()::text, true);
/*p_hold:__RUN__*/ SELECT pg_sleep(4);
