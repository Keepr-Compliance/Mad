-- BACKLOG-3962 PR1 rollback for 20261112100000_backlog_3962_domain_claims.sql.
-- Removes every object that migration created. The claims are lost; run only when the feature
-- is being withdrawn. Afterwards delete the schema_migrations row for 20261112100000.
DROP FUNCTION IF EXISTS public.admin_revoke_domain_claim(uuid, text);
DROP FUNCTION IF EXISTS public.admin_list_domain_claims(uuid);
DROP FUNCTION IF EXISTS public._domain_claims_due_for_recheck(integer);
DROP FUNCTION IF EXISTS public._domain_claim_record_check(uuid, uuid, text[], boolean, text);
DROP FUNCTION IF EXISTS public._domain_claim_begin_check(uuid, uuid);
DROP FUNCTION IF EXISTS public.domain_claim_withdraw(uuid);
DROP FUNCTION IF EXISTS public.domain_claim_create(uuid, text);
DROP TABLE IF EXISTS public.domain_claims;
DROP FUNCTION IF EXISTS public._is_consumer_email_domain(text);
DROP FUNCTION IF EXISTS public._normalize_claim_domain(text);
