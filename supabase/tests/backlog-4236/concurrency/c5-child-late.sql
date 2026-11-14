-- C5 first session: the transaction starts, waits 4 s, then upserts one party on deal cc-1. The mark in the
-- second session starts later and commits during the wait.
SELECT pg_sleep(4) /*p_hold:__RUN__*/ AS hold;
SELECT public.cloud_upsert_parties('__A__'::uuid, '__I__'::uuid, '__DEAL__'::uuid, jsonb_build_array(
  jsonb_build_object('local_id', 'cc-p5', 'content_hash', encode(sha256('cc-p5'::bytea), 'hex'), 'display_name', 'Party c5'))) AS r;
