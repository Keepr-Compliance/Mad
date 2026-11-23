-- Session B's gate: waits (server side, up to 20 s) until another backend sleeps in a call whose text carries this
-- run's hold marker. The marker is split here so this text never matches itself.
DO $g$ DECLARE i integer := 0; BEGIN
  WHILE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event = 'PgSleep'
                     AND query LIKE '%p_hold:' || '__RUN__' || '*/%') LOOP
    i := i + 1;
    IF i > 200 THEN RAISE EXCEPTION 'P_GATE_TIMEOUT'; END IF;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $g$;
