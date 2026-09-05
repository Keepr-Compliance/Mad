-- BACKLOG-3096 -- restore the shipped function after running a mutant.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/backlog-3096/mutants/restore-shipped.sql
--
-- Re-applies the migration itself rather than a second copy of the body, so
-- restore can never drift from what the PR ships.
--
-- The path is relative to THIS file, so run psql from anywhere.

\ir ../../../migrations/20260905_backlog_3096_setup_first_user_wins.sql

SELECT 'shipped definition restored' AS status;
