-- C5 second session: mark deal cc-1 fully saved while the first session waits.
SELECT public.cloud_mark_deal_synced('__A__'::uuid, '__I__'::uuid, '__DEAL__'::uuid) AS r;
