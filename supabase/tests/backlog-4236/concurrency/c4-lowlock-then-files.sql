-- C4 (as the table owner first): hold the lower-id blob 3 s, then attach both blobs to deal cc-4a as
-- the user, in id order (low, high), in the same transaction.
SELECT 1 FROM public.cloud_blobs WHERE id = '__LOW_ID__'::uuid FOR UPDATE;
SELECT pg_sleep(3) /*p_hold:__RUN__*/;
