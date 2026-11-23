-- /*t:drop*/ Drops both own-name copies, then answers how many public.*_m4263 functions are left (must be 0).
SET LOCAL lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.cloud_blob_erase_claim_m4263(boolean, integer, integer);
DROP FUNCTION IF EXISTS public.cloud_blob_erase_scrub_m4263(uuid, uuid, boolean, integer);
SELECT count(*) AS left FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%\_m4263';
