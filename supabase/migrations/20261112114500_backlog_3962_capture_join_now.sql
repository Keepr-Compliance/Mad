-- BACKLOG-3962: "Join now". A person with a scheduled domain capture move joins the brokerage
-- before the switch date, from the portal banner, after a confirm step.
--
-- _domain_capture_join_now(p_switch uuid, p_user uuid)   server role only (checked inside)
--   The portal action takes p_user from the signed-in session (auth.getUser()), never from posted
--   input, and calls this with the server role: auth.uid() is NULL there, and _domain_capture_switch
--   refuses every other role.
--   Under the row lock:
--     a) the row must exist and belong to p_user (else switch_not_found, the same answer for both);
--     b) it must still be scheduled (else not_scheduled + status);
--     c) a notice still undecided (notice_delivered NULL, queued for retry) is marked delivered:
--        the person saw the banner and confirmed in the portal;
--     d) switch_at is brought forward to now() and _domain_capture_switch runs unchanged, so every
--        check it makes (claim, fresh DNS, candidate rule, attestation, 3850 gate, Billing step,
--        seats, suspension) applies to an early join exactly as to the scheduled one;
--     e) switch_at is put back to the original value on EVERY outcome. On a deferral
--        (success false) last_defer_reason is restored too, so the hourly job does not see the row
--        as due and the person can still opt out. On 'switched', joined_early_at records the early
--        join (switch_at stays the scheduled date; switched_at is the time of the move).
--   An error raised inside _domain_capture_switch rolls back the whole call, step d included.
--
-- domain_capture_switches gains joined_early_at timestamptz. The table's existing revokes
-- (20261112113000) cover the new column; no client role reads or writes the table.
--
-- Rollback: supabase/tests/backlog-3962/rollback-3962-join-now.sql.
-- Harness: supabase/tests/backlog-3962/controls-join-now.sql (compose.py modes join*).

DO $guard$
BEGIN
  IF to_regclass('public.domain_capture_switches') IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-3962 join now: public.domain_capture_switches does not exist (20261112113000 first)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.domain_capture_switches'::regclass
                AND attname = 'joined_early_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'BACKLOG-3962 join now: joined_early_at already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace AND proname = '_domain_capture_join_now') THEN
    RAISE EXCEPTION 'BACKLOG-3962 join now: _domain_capture_join_now already exists';
  END IF;
  -- Join now relies on the switch refusing a row that is not due yet (it moves switch_at first).
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = to_regprocedure('public._domain_capture_switch(uuid)')
                    AND prosrc LIKE '%now() < v_row.switch_at%') THEN
    RAISE EXCEPTION 'BACKLOG-3962 join now: _domain_capture_switch has no not-due check';
  END IF;
END
$guard$;

ALTER TABLE public.domain_capture_switches ADD COLUMN joined_early_at timestamptz;

CREATE FUNCTION public._domain_capture_join_now(p_switch uuid, p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_row public.domain_capture_switches;
  v_reply jsonb;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.domain_capture_switches s WHERE s.id = p_switch FOR UPDATE;
  -- Not found and someone else's row read the same.
  IF NOT FOUND OR p_user IS NULL OR v_row.user_id IS DISTINCT FROM p_user THEN
    RETURN jsonb_build_object('success', false, 'error', 'switch_not_found');
  END IF;
  IF v_row.status <> 'scheduled' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_scheduled', 'status', v_row.status);
  END IF;

  -- The person saw the banner and confirmed in the portal: a notice still queued for retry counts
  -- as delivered.
  IF v_row.notice_delivered IS NULL THEN
    UPDATE public.domain_capture_switches
       SET notice_delivered = true, notice_sent_at = coalesce(notice_sent_at, now()), updated_at = now()
     WHERE id = v_row.id;
  END IF;

  UPDATE public.domain_capture_switches
     SET switch_at = least(v_row.switch_at, now()), updated_at = now()
   WHERE id = v_row.id;

  v_reply := public._domain_capture_switch(v_row.id);

  IF (v_reply ->> 'success') IS DISTINCT FROM 'true' THEN
    -- Deferred: nothing changes. The move stays on its date and can still be opted out of.
    UPDATE public.domain_capture_switches
       SET switch_at = v_row.switch_at, last_defer_reason = v_row.last_defer_reason, updated_at = now()
     WHERE id = v_row.id;
    RETURN v_reply;
  END IF;

  UPDATE public.domain_capture_switches
     SET switch_at = v_row.switch_at,
         joined_early_at = CASE WHEN v_reply ->> 'outcome' = 'switched' THEN now() ELSE joined_early_at END,
         updated_at = now()
   WHERE id = v_row.id;

  IF v_reply ->> 'outcome' = 'switched' THEN
    RETURN v_reply || jsonb_build_object('joined_early', true);
  END IF;
  RETURN v_reply;
END;
$function$;

REVOKE ALL ON FUNCTION public._domain_capture_join_now(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._domain_capture_join_now(uuid, uuid) TO service_role;

-- POSTCHECK BEGIN
DO $post$
DECLARE f text := 'public._domain_capture_join_now(uuid, uuid)';
BEGIN
  IF has_function_privilege('anon', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'BACKLOG-3962 join now: anon can execute %', f;
  END IF;
  IF has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'BACKLOG-3962 join now: authenticated can execute %', f;
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'BACKLOG-3962 join now: the server role cannot execute %', f;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f::regprocedure
                   AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']) THEN
    RAISE EXCEPTION 'BACKLOG-3962 join now: % is not SECURITY DEFINER with an empty search_path', f;
  END IF;
END
$post$;
-- POSTCHECK END
