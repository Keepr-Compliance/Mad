-- BACKLOG-4170 PR2c — support functions: requester checks and event filtering
--
-- support_add_message
--   A caller without support.view may add a message only to a ticket they requested:
--     signed in   requester_id = auth.uid() OR requester_email = the caller's auth email (the rule
--                 support_get_ticket_detail and support_is_ticket_requester apply to a signed-in
--                 non-agent)
--     signed out  lower(requester_email) = lower(p_sender_email)
--   Any other ticket gets the function's existing reply for an unknown ticket ('Ticket not found').
--   Agents (support.view) are unchanged.
-- support_get_ticket_detail, support_list_events
--   A caller without support.view does not receive event rows with event_type = 'message_added'
--   and new_value = 'internal_note', or with event_type = 'internal_note_deleted'. Agents receive
--   every row, as before.
--
-- Only those lines differ from the PR2b bodies (20261111115000). Every other line and every RAISE
-- text is unchanged.
--
-- Grants: unchanged (no REVOKE / GRANT in this file). PUBLIC, anon, authenticated and service_role
-- keep EXECUTE on all 3. Intentionally callable signed out:
--   support_add_message          a signed-out requester replies to their ticket (p_sender_email)
--   support_get_ticket_detail    a signed-out requester reads their ticket (p_requester_email)
--   support_list_events          returns [] to a caller with no user id
--
-- Pre-pin: the migration stops unless each body is the PR2b text or this file's text.
-- Rollback: supabase/tests/backlog-4170-p2c/rollback-4170-p2c.sql (PR2b text; ACL unchanged).

DO $pin$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT v.sig, v.prev, v.post, md5(p.prosrc) AS cur
      FROM (VALUES
        ('public.support_add_message(uuid,text,text,text,text)', '9d9cb01bb5a1fed81f584aa6f268118c', '3bdb2c269b47a42a5f70bf09295c638c'),
        ('public.support_get_ticket_detail(uuid,text)', 'fd14d57fe2cbd29a39a6e1af7b75e23f', '24dab3474673fb425725e9cfdc004118'),
        ('public.support_list_events(uuid)', '269465224f282e27485b37fa0f2830e0', 'd7333c467e6e7f8f8bb1a292aeaf0ae7')
      ) AS v(sig, prev, post)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(v.sig)
  LOOP
    IF r.cur IS NULL THEN
      RAISE EXCEPTION 'BACKLOG-4170 PR2c: % not found', r.sig;
    END IF;
    IF r.cur NOT IN (r.prev, r.post) THEN
      RAISE EXCEPTION 'BACKLOG-4170 PR2c: % body changed (md5 %); re-review before applying', r.sig, r.cur;
    END IF;
  END LOOP;
END
$pin$;

-- Intentionally callable by anon: a signed-out requester replies to their own ticket (p_sender_email must equal the ticket's requester_email, case-insensitive)
CREATE OR REPLACE FUNCTION public.support_add_message(p_ticket_id uuid, p_body text, p_message_type text DEFAULT 'reply'::text, p_sender_email text DEFAULT NULL::text, p_sender_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_message_id UUID;
  v_sender_id UUID;
  v_sender_email TEXT;
  v_sender_name TEXT;
  v_ticket_exists BOOLEAN;
  v_is_agent BOOLEAN;
  v_ticket_status TEXT;
BEGIN
  SELECT EXISTS(SELECT 1 FROM support_tickets WHERE id = p_ticket_id),
         (SELECT status FROM support_tickets WHERE id = p_ticket_id)
  INTO v_ticket_exists, v_ticket_status;

  IF NOT v_ticket_exists THEN
    RAISE EXCEPTION 'Ticket not found: %', p_ticket_id;
  END IF;

  IF p_message_type NOT IN ('reply', 'internal_note') THEN
    RAISE EXCEPTION 'Invalid message_type: %. Must be reply or internal_note', p_message_type;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    v_sender_id := auth.uid();
    v_sender_email := COALESCE(p_sender_email, (SELECT email FROM auth.users WHERE id = auth.uid()));
    v_sender_name := COALESCE(
      p_sender_name,
      (SELECT display_name FROM profiles WHERE id = auth.uid()),
      (SELECT raw_user_meta_data->>'full_name' FROM auth.users WHERE id = auth.uid()),
      v_sender_email
    );
    v_is_agent := public.has_permission(auth.uid(), 'support.view');
    IF NOT v_is_agent AND NOT EXISTS (
      SELECT 1 FROM support_tickets
      WHERE id = p_ticket_id
      AND (requester_id = auth.uid() OR requester_email = (SELECT email FROM auth.users WHERE id = auth.uid()))
    ) THEN
      RAISE EXCEPTION 'Ticket not found: %', p_ticket_id;
    END IF;
  ELSE
    IF p_sender_email IS NULL THEN
      RAISE EXCEPTION 'sender_email is required for unauthenticated messages';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM support_tickets
      WHERE id = p_ticket_id
      AND lower(requester_email) = lower(p_sender_email)
    ) THEN
      RAISE EXCEPTION 'Ticket not found: %', p_ticket_id;
    END IF;
    v_sender_id := NULL;
    v_sender_email := p_sender_email;
    v_sender_name := COALESCE(p_sender_name, p_sender_email);
    v_is_agent := false;
  END IF;

  IF p_message_type = 'internal_note' AND NOT v_is_agent THEN
    RAISE EXCEPTION 'Only agents can add internal notes';
  END IF;

  INSERT INTO support_ticket_messages (ticket_id, sender_id, sender_email, sender_name, message_type, body)
  VALUES (p_ticket_id, v_sender_id, v_sender_email, v_sender_name, p_message_type, p_body)
  RETURNING id INTO v_message_id;

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, new_value, metadata)
  VALUES (
    p_ticket_id,
    v_sender_id,
    'message_added',
    p_message_type,
    jsonb_build_object('message_id', v_message_id, 'sender_email', v_sender_email)
  );

  IF v_is_agent AND p_message_type = 'reply' THEN
    UPDATE support_tickets
    SET first_response_at = COALESCE(first_response_at, now())
    WHERE id = p_ticket_id AND first_response_at IS NULL;
  END IF;

  -- Auto-reopen: when a customer (non-agent) replies to a resolved/closed ticket,
  -- automatically reopen it so agents see it needs attention again.
  IF NOT v_is_agent AND p_message_type = 'reply' AND v_ticket_status IN ('resolved', 'closed') THEN
    UPDATE support_tickets
    SET status = 'in_progress', reopened_count = reopened_count + 1, updated_at = now()
    WHERE id = p_ticket_id;

    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
    VALUES (
      p_ticket_id,
      v_sender_id,
      'status_changed',
      v_ticket_status,
      'in_progress',
      jsonb_build_object('reason', 'customer_reply_after_resolved', 'message_id', v_message_id, 'auto', true)
    );
  END IF;

  RETURN jsonb_build_object(
    'id', v_message_id,
    'ticket_id', p_ticket_id,
    'message_type', p_message_type,
    'sender_email', v_sender_email
  );
END;
$function$;

-- Intentionally callable by anon: a signed-out requester reads their own ticket (p_requester_email must match)
CREATE OR REPLACE FUNCTION public.support_get_ticket_detail(p_ticket_id uuid, p_requester_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ticket JSONB;
  v_messages JSONB;
  v_events JSONB;
  v_attachments JSONB;
  v_participants JSONB;
  v_is_agent BOOLEAN;
  v_caller_id UUID := auth.uid();
  v_ticket_exists BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM support_tickets WHERE id = p_ticket_id)
  INTO v_ticket_exists;

  IF NOT v_ticket_exists THEN
    RAISE EXCEPTION 'Ticket not found: %', p_ticket_id;
  END IF;

  v_is_agent := public.has_permission(v_caller_id, 'support.view');

  IF v_caller_id IS NULL THEN
    IF p_requester_email IS NULL THEN
      RAISE EXCEPTION 'requester_email is required to view ticket details without authentication';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM support_tickets
      WHERE id = p_ticket_id
      AND requester_email = p_requester_email
    ) THEN
      RAISE EXCEPTION 'Access denied: email does not match ticket requester';
    END IF;
  ELSIF NOT v_is_agent THEN
    IF NOT EXISTS (
      SELECT 1 FROM support_tickets
      WHERE id = p_ticket_id
      AND (requester_id = v_caller_id OR requester_email = (SELECT email FROM auth.users WHERE id = v_caller_id))
    ) THEN
      RAISE EXCEPTION 'Access denied: you can only view your own tickets';
    END IF;
  END IF;

  SELECT to_jsonb(t.*) INTO v_ticket
  FROM support_tickets t WHERE t.id = p_ticket_id;

  SELECT COALESCE(jsonb_agg(
    to_jsonb(m.*) ORDER BY m.created_at ASC
  ), '[]'::jsonb) INTO v_messages
  FROM support_ticket_messages m
  WHERE m.ticket_id = p_ticket_id
  AND (v_is_agent OR m.message_type != 'internal_note');

  -- Get events with actor name
  SELECT COALESCE(jsonb_agg(
    to_jsonb(e.*) || jsonb_build_object(
      'actor_name', COALESCE(p.display_name, u.raw_user_meta_data->>'full_name', u.email),
      'actor_email', u.email
    )
    ORDER BY e.created_at ASC
  ), '[]'::jsonb) INTO v_events
  FROM support_ticket_events e
  LEFT JOIN auth.users u ON u.id = e.actor_id
  LEFT JOIN profiles p ON p.id = e.actor_id
  WHERE e.ticket_id = p_ticket_id
  AND (v_is_agent OR NOT ((e.event_type = 'message_added' AND e.new_value IS NOT DISTINCT FROM 'internal_note') OR e.event_type = 'internal_note_deleted'));

  SELECT COALESCE(jsonb_agg(
    to_jsonb(a.*) ORDER BY a.created_at ASC
  ), '[]'::jsonb) INTO v_attachments
  FROM support_ticket_attachments a
  WHERE a.ticket_id = p_ticket_id
  AND (
    v_is_agent
    OR a.message_id IS NULL
    OR EXISTS (SELECT 1 FROM support_ticket_messages m WHERE m.id = a.message_id AND m.message_type != 'internal_note')
  );

  SELECT COALESCE(jsonb_agg(
    to_jsonb(p.*) ORDER BY p.created_at ASC
  ), '[]'::jsonb) INTO v_participants
  FROM support_ticket_participants p
  WHERE p.ticket_id = p_ticket_id;

  RETURN jsonb_build_object(
    'ticket', v_ticket,
    'messages', v_messages,
    'events', v_events,
    'attachments', v_attachments,
    'participants', v_participants
  );
END;
$function$;

-- Intentionally callable by anon: returns [] to a caller with no user id
CREATE OR REPLACE FUNCTION public.support_list_events(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_is_internal boolean;
BEGIN
  v_caller := auth.uid();

  IF v_caller IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  v_is_internal := public.has_permission(v_caller, 'support.view');

  IF NOT (v_is_internal OR support_is_ticket_requester(p_ticket_id::text)) THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN COALESCE(
    (SELECT jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'ticket_id', e.ticket_id,
        'actor_id', e.actor_id,
        'event_type', e.event_type,
        'old_value', e.old_value,
        'new_value', e.new_value,
        'metadata', e.metadata,
        'created_at', e.created_at
      ) ORDER BY e.created_at DESC
    )
    FROM support_ticket_events e
    WHERE e.ticket_id = p_ticket_id
    AND (v_is_internal OR NOT ((e.event_type = 'message_added' AND e.new_value IS NOT DISTINCT FROM 'internal_note') OR e.event_type = 'internal_note_deleted'))),
    '[]'::jsonb
  );
END;
$function$;
