-- Session-2 gate: waits (server side, up to 20 s) until another backend is sleeping in a statement that
-- carries this run's hold marker, so session 2's next statement starts while session 1 holds its locks.
-- The marker is split here so this text never matches itself.
DO $gate$
DECLARE i integer := 0;
BEGIN
  WHILE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity
                     WHERE pid <> pg_backend_pid() AND wait_event = 'PgSleep'
                       AND query LIKE '%p_hold:' || '__RUN__' || '*/%') LOOP
    i := i + 1;
    IF i > 200 THEN RAISE EXCEPTION 'P_GATE_TIMEOUT: holder not seen within 20 s'; END IF;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $gate$;
