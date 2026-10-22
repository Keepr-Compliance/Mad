-- BACKLOG-3854 rollback (keepr-test only). The migration adds three functions and replaces
-- nothing, so rollback drops them and removes the ledger row. Seat changes already made through
-- broker_add_seats stay (they are ordinary _billing_change_seats changes).
BEGIN;
DROP FUNCTION IF EXISTS public.broker_add_seats(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.broker_get_seats(uuid);
DROP FUNCTION IF EXISTS public._org_seat_add_refusal(public.org_deals);
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261021020000';
COMMIT;
