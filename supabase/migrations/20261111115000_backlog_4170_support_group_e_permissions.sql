-- BACKLOG-4170 PR2b — 9 support functions shared by agents and requesters (group E)
--
-- Each function below decided its agent / internal path with "the caller holds any internal role"
-- (a v_is_agent / v_is_internal variable in 6 bodies, an inline EXISTS on internal_roles in 3).
-- That one expression is replaced by the support permission the admin-portal support pages already
-- require (route /dashboard/support needs support.view):
--
--   support.view                         support_add_message, support_get_ticket_detail,
--                                        support_list_tickets, support_add_attachment,
--                                        support_add_diagnostic_attachment, support_list_attachments,
--                                        support_list_events, support_record_attachment_access
--   support.manage or support.admin      support_delete_own_attachment (deleting an attachment on a
--                                        ticket the caller did not request)
--
-- has_permission / has_any_permission join internal_roles (a caller holding the key holds an internal
-- role), are caller-bound (check_user_id = auth.uid()) and never return NULL, so the internal-role
-- check is not kept beside them. An internal user without the key now takes the requester path: own
-- tickets only, no internal notes (the same outcome as the 4145 M2 table policies). Every requester
-- branch (requester_id, requester_email, p_requester_email, p_sender_email) is the production text,
-- and every refusal keeps its RAISE text. Only the changed line differs from each production body.
--
-- Grants: unchanged (no REVOKE / GRANT in this file). PUBLIC, anon, authenticated and service_role
-- keep EXECUTE on all 9. These functions are intentionally callable signed out:
--   support_add_message          a signed-out requester replies to their ticket (p_sender_email)
--   support_get_ticket_detail    a signed-out requester reads their ticket (p_requester_email must
--                                equal the ticket's requester_email)
--   support_list_attachments,    return [] to a caller with no user id; revoking anon would turn
--   support_list_events          that empty reply into an error
--   the other 5                  refuse a caller with no user id inside the body ("Authentication
--                                required"), before any read or write
--
-- Pre-pin: the migration stops unless each body is the production text or this file's text.
-- Rollback: supabase/tests/backlog-4170-p2b/rollback-4170-p2b.sql (production text and ACL).

DO $pin$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT v.sig, v.prod, v.post, md5(p.prosrc) AS cur
      FROM (VALUES
        ('public.support_add_message(uuid,text,text,text,text)', 'e3e727b1bfe3b691d9dfabf42cfbd1f3', '9d9cb01bb5a1fed81f584aa6f268118c'),
        ('public.support_get_ticket_detail(uuid,text)', 'b928028c9f9593a1f93969f4b8369cf7', 'fd14d57fe2cbd29a39a6e1af7b75e23f'),
        ('public.support_list_tickets(text,text,uuid,uuid,text,text,integer,integer,text,text)', '5766828b06209e1eea2bddbe9b2fde50', '6220590c8de1afd36c0f03152c3e7d92'),
        ('public.support_add_attachment(uuid,uuid,text,bigint,text,text)', 'aa3a50264023fc32fee00d6d4143fc45', '25d8804822f9512df1ab5b37341a36a7'),
        ('public.support_add_diagnostic_attachment(uuid,text,bigint,text,text,integer)', 'a297e2cf5e4d12477635396471a394b5', '5d1cd82cfbe147bafb45ebdf41ff0e13'),
        ('public.support_delete_own_attachment(uuid)', '2b572da7a34406c679369645cb11eb4f', '7ecbe698370302a1659f11a43606de51'),
        ('public.support_list_attachments(uuid)', '38d3854b45e5280ceb12e1bdc92e273f', '48d9e3f2c8a85e760b47a2448dd8fae0'),
        ('public.support_list_events(uuid)', 'c1d3c37c7eccf1ef9fc87e584f5cce97', '269465224f282e27485b37fa0f2830e0'),
        ('public.support_record_attachment_access(uuid)', '6dd6d0b646e5787ef3bf65e6d19848ef', 'a1c89e345b3dbccc6d61a50bfc74b84f')
      ) AS v(sig, prod, post)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(v.sig)
  LOOP
    IF r.cur IS NULL THEN
      RAISE EXCEPTION 'BACKLOG-4170 PR2b: % not found', r.sig;
    END IF;
    IF r.cur NOT IN (r.prod, r.post) THEN
      RAISE EXCEPTION 'BACKLOG-4170 PR2b: % body changed (md5 %); re-review before applying', r.sig, r.cur;
    END IF;
  END LOOP;
END
$pin$;

-- support.view
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
  ELSE
    IF p_sender_email IS NULL THEN
      RAISE EXCEPTION 'sender_email is required for unauthenticated messages';
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

-- support.view
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
  WHERE e.ticket_id = p_ticket_id;

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

-- support.view
CREATE OR REPLACE FUNCTION public.support_list_tickets(p_status text DEFAULT NULL::text, p_priority text DEFAULT NULL::text, p_category_id uuid DEFAULT NULL::uuid, p_assignee_id uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_requester_email text DEFAULT NULL::text, p_page integer DEFAULT 1, p_page_size integer DEFAULT 20, p_sort_by text DEFAULT 'created_at'::text, p_sort_dir text DEFAULT 'desc'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_agent BOOLEAN;
  v_caller_id UUID := auth.uid();
  v_caller_email TEXT;
  v_total_count INT;
  v_tickets JSONB;
  v_offset INT;
  v_query tsquery;
  v_ilike TEXT;
  v_ticket_num INT;
  v_sort_by TEXT;
  v_sort_dir TEXT;
BEGIN
  -- Auth guard: must be authenticated
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required to list tickets';
  END IF;

  v_offset := (p_page - 1) * p_page_size;
  v_is_agent := public.has_permission(v_caller_id, 'support.view');

  SELECT email INTO v_caller_email FROM auth.users WHERE id = v_caller_id;

  -- Validate sort parameters (whitelist to prevent SQL injection)
  v_sort_by := CASE p_sort_by
    WHEN 'ticket_number' THEN 'ticket_number'
    WHEN 'subject' THEN 'subject'
    WHEN 'status' THEN 'status'
    WHEN 'priority' THEN 'priority'
    WHEN 'created_at' THEN 'created_at'
    WHEN 'assignee_name' THEN 'assignee_name'
    ELSE 'created_at'
  END;

  v_sort_dir := CASE LOWER(p_sort_dir)
    WHEN 'asc' THEN 'asc'
    WHEN 'desc' THEN 'desc'
    ELSE 'desc'
  END;

  -- Pre-compute the tsquery once (NULL if no search)
  IF p_search IS NOT NULL THEN
    v_query := plainto_tsquery('english', p_search);
    v_ilike := '%' || p_search || '%';

    -- Parse ticket number from search input
    IF p_search ~ '^\s*#?\s*\d+\s*$' THEN
      v_ticket_num := (regexp_replace(p_search, '[^0-9]', '', 'g'))::INT;
    ELSIF p_search ~* '^\s*TKT-?0*(\d+)\s*$' THEN
      v_ticket_num := (regexp_replace(p_search, '[^0-9]', '', 'g'))::INT;
    END IF;
  END IF;

  -- Count total
  SELECT COUNT(*) INTO v_total_count
  FROM support_tickets t
  WHERE
    -- Status filter: when NULL, exclude 'deleted'; when specified, match exactly
    (CASE
      WHEN p_status IS NULL THEN t.status != 'deleted'
      ELSE t.status = p_status
    END)
    AND (p_priority IS NULL OR t.priority = p_priority)
    AND (p_category_id IS NULL OR t.category_id = p_category_id)
    AND (p_assignee_id IS NULL OR t.assignee_id = p_assignee_id)
    AND (p_search IS NULL OR (
      (v_ticket_num IS NOT NULL AND t.ticket_number = v_ticket_num)
      OR t.search_vector @@ v_query
      OR t.requester_name ILIKE v_ilike
      OR t.requester_email ILIKE v_ilike
      OR EXISTS (
        SELECT 1 FROM support_ticket_messages m
        WHERE m.ticket_id = t.id
        AND m.search_vector @@ v_query
        AND (v_is_agent OR m.message_type != 'internal_note')
      )
    ))
    AND (p_requester_email IS NULL OR (v_is_agent AND t.requester_email = p_requester_email))
    AND (
      v_is_agent
      OR (t.requester_id = v_caller_id OR t.requester_email = v_caller_email)
    );

  -- Get page with optional search highlights.
  SELECT COALESCE(jsonb_agg(ticket_data ORDER BY ticket_num_priority, row_num), '[]'::jsonb) INTO v_tickets
  FROM (
    SELECT
      to_jsonb(t.*) || jsonb_build_object(
        'category_name', c.name,
        'subcategory_name', sc.name,
        'assignee_name', COALESCE(au.raw_user_meta_data->>'full_name', au.email),
        'assignee_email', au.email,
        'search_highlights', CASE
          WHEN p_search IS NULL THEN NULL
          ELSE (
            SELECT jsonb_agg(h) FILTER (WHERE h IS NOT NULL)
            FROM (
              SELECT jsonb_build_object(
                'field', 'subject',
                'snippet', ts_headline('english', t.subject, v_query,
                  'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15, MaxFragments=1')
              ) AS h
              WHERE to_tsvector('english', coalesce(t.subject, '')) @@ v_query

              UNION ALL

              SELECT jsonb_build_object(
                'field', 'description',
                'snippet', ts_headline('english', t.description, v_query,
                  'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15, MaxFragments=1')
              )
              WHERE to_tsvector('english', coalesce(t.description, '')) @@ v_query

              UNION ALL

              SELECT jsonb_build_object(
                'field', 'requester_name',
                'snippet', ts_headline('english', t.requester_name, v_query,
                  'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15, MaxFragments=1')
              )
              WHERE to_tsvector('english', coalesce(t.requester_name, '')) @@ v_query

              UNION ALL

              SELECT jsonb_build_object(
                'field', 'requester_name',
                'snippet', replace(t.requester_name, p_search,
                  '<mark>' || p_search || '</mark>')
              )
              WHERE t.requester_name ILIKE v_ilike
              AND NOT (to_tsvector('english', coalesce(t.requester_name, '')) @@ v_query)

              UNION ALL

              SELECT jsonb_build_object(
                'field', 'requester_email',
                'snippet', replace(t.requester_email, p_search,
                  '<mark>' || p_search || '</mark>')
              )
              WHERE t.requester_email ILIKE v_ilike

              UNION ALL

              SELECT jsonb_build_object(
                'field', 'message',
                'snippet', ts_headline('english', m.body, v_query,
                  'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15, MaxFragments=1'),
                'sender_name', m.sender_name,
                'sent_at', m.created_at
              )
              FROM support_ticket_messages m
              WHERE m.ticket_id = t.id
              AND m.search_vector @@ v_query
              AND (v_is_agent OR m.message_type != 'internal_note')
            ) highlights
          )
        END
      ) AS ticket_data,
      CASE WHEN v_ticket_num IS NOT NULL AND t.ticket_number = v_ticket_num THEN 0 ELSE 1 END AS ticket_num_priority,
      ROW_NUMBER() OVER (
        ORDER BY
          CASE WHEN v_ticket_num IS NOT NULL AND t.ticket_number = v_ticket_num THEN 0 ELSE 1 END,
          CASE WHEN v_sort_by = 'ticket_number' AND v_sort_dir = 'asc' THEN t.ticket_number END ASC,
          CASE WHEN v_sort_by = 'ticket_number' AND v_sort_dir = 'desc' THEN t.ticket_number END DESC,
          CASE WHEN v_sort_by = 'subject' AND v_sort_dir = 'asc' THEN lower(t.subject) END ASC,
          CASE WHEN v_sort_by = 'subject' AND v_sort_dir = 'desc' THEN lower(t.subject) END DESC,
          CASE WHEN v_sort_by = 'status' AND v_sort_dir = 'asc' THEN t.status END ASC,
          CASE WHEN v_sort_by = 'status' AND v_sort_dir = 'desc' THEN t.status END DESC,
          CASE WHEN v_sort_by = 'priority' AND v_sort_dir = 'asc' THEN
            CASE t.priority WHEN 'low' THEN 1 WHEN 'normal' THEN 2 WHEN 'high' THEN 3 WHEN 'urgent' THEN 4 ELSE 0 END
          END ASC,
          CASE WHEN v_sort_by = 'priority' AND v_sort_dir = 'desc' THEN
            CASE t.priority WHEN 'low' THEN 1 WHEN 'normal' THEN 2 WHEN 'high' THEN 3 WHEN 'urgent' THEN 4 ELSE 0 END
          END DESC,
          CASE WHEN v_sort_by = 'created_at' AND v_sort_dir = 'asc' THEN t.created_at END ASC,
          CASE WHEN v_sort_by = 'created_at' AND v_sort_dir = 'desc' THEN t.created_at END DESC,
          CASE WHEN v_sort_by = 'assignee_name' AND v_sort_dir = 'asc' THEN lower(COALESCE(au.raw_user_meta_data->>'full_name', au.email, 'zzz')) END ASC,
          CASE WHEN v_sort_by = 'assignee_name' AND v_sort_dir = 'desc' THEN lower(COALESCE(au.raw_user_meta_data->>'full_name', au.email, '')) END DESC,
          t.created_at DESC
      ) AS row_num
    FROM support_tickets t
    LEFT JOIN support_categories c ON c.id = t.category_id
    LEFT JOIN support_categories sc ON sc.id = t.subcategory_id
    LEFT JOIN auth.users au ON au.id = t.assignee_id
    WHERE
      -- Status filter: when NULL, exclude 'deleted'; when specified, match exactly
      (CASE
        WHEN p_status IS NULL THEN t.status != 'deleted'
        ELSE t.status = p_status
      END)
      AND (p_priority IS NULL OR t.priority = p_priority)
      AND (p_category_id IS NULL OR t.category_id = p_category_id)
      AND (p_assignee_id IS NULL OR t.assignee_id = p_assignee_id)
      AND (p_search IS NULL OR (
        (v_ticket_num IS NOT NULL AND t.ticket_number = v_ticket_num)
        OR t.search_vector @@ v_query
        OR EXISTS (
          SELECT 1 FROM support_ticket_messages m
          WHERE m.ticket_id = t.id
          AND m.search_vector @@ v_query
          AND (v_is_agent OR m.message_type != 'internal_note')
        )
      ))
      AND (p_requester_email IS NULL OR (v_is_agent AND t.requester_email = p_requester_email))
      AND (
        v_is_agent
        OR (t.requester_id = v_caller_id OR t.requester_email = v_caller_email)
      )
    ORDER BY
      CASE WHEN v_ticket_num IS NOT NULL AND t.ticket_number = v_ticket_num THEN 0 ELSE 1 END,
      CASE WHEN v_sort_by = 'ticket_number' AND v_sort_dir = 'asc' THEN t.ticket_number END ASC,
      CASE WHEN v_sort_by = 'ticket_number' AND v_sort_dir = 'desc' THEN t.ticket_number END DESC,
      CASE WHEN v_sort_by = 'subject' AND v_sort_dir = 'asc' THEN lower(t.subject) END ASC,
      CASE WHEN v_sort_by = 'subject' AND v_sort_dir = 'desc' THEN lower(t.subject) END DESC,
      CASE WHEN v_sort_by = 'status' AND v_sort_dir = 'asc' THEN t.status END ASC,
      CASE WHEN v_sort_by = 'status' AND v_sort_dir = 'desc' THEN t.status END DESC,
      CASE WHEN v_sort_by = 'priority' AND v_sort_dir = 'asc' THEN
        CASE t.priority WHEN 'low' THEN 1 WHEN 'normal' THEN 2 WHEN 'high' THEN 3 WHEN 'urgent' THEN 4 ELSE 0 END
      END ASC,
      CASE WHEN v_sort_by = 'priority' AND v_sort_dir = 'desc' THEN
        CASE t.priority WHEN 'low' THEN 1 WHEN 'normal' THEN 2 WHEN 'high' THEN 3 WHEN 'urgent' THEN 4 ELSE 0 END
      END DESC,
      CASE WHEN v_sort_by = 'created_at' AND v_sort_dir = 'asc' THEN t.created_at END ASC,
      CASE WHEN v_sort_by = 'created_at' AND v_sort_dir = 'desc' THEN t.created_at END DESC,
      CASE WHEN v_sort_by = 'assignee_name' AND v_sort_dir = 'asc' THEN lower(COALESCE(au.raw_user_meta_data->>'full_name', au.email, 'zzz')) END ASC,
      CASE WHEN v_sort_by = 'assignee_name' AND v_sort_dir = 'desc' THEN lower(COALESCE(au.raw_user_meta_data->>'full_name', au.email, '')) END DESC,
      t.created_at DESC
    LIMIT p_page_size
    OFFSET v_offset
  ) sub;

  RETURN jsonb_build_object(
    'tickets', v_tickets,
    'total_count', v_total_count,
    'page', p_page,
    'page_size', p_page_size,
    'total_pages', CEIL(v_total_count::numeric / p_page_size)
  );
END;
$function$;

-- support.view
CREATE OR REPLACE FUNCTION public.support_add_attachment(p_ticket_id uuid, p_message_id uuid DEFAULT NULL::uuid, p_file_name text DEFAULT ''::text, p_file_size bigint DEFAULT 0, p_file_type text DEFAULT ''::text, p_storage_path text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_attachment_id uuid;
  v_uploader_id uuid;
BEGIN
  v_uploader_id := auth.uid();

  IF v_uploader_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required to add an attachment'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (
    support_is_ticket_requester(p_ticket_id::text)
    OR public.has_permission(v_uploader_id, 'support.view')
  ) THEN
    RAISE EXCEPTION 'Not authorised to attach to this ticket'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO support_ticket_attachments (
    ticket_id, message_id, file_name, file_size, file_type, storage_path, uploaded_by
  ) VALUES (
    p_ticket_id, p_message_id, p_file_name, p_file_size, p_file_type, p_storage_path, v_uploader_id
  )
  RETURNING id INTO v_attachment_id;

  RETURN jsonb_build_object('id', v_attachment_id, 'storage_path', p_storage_path);
END;
$function$;

-- support.view
CREATE OR REPLACE FUNCTION public.support_add_diagnostic_attachment(p_ticket_id uuid, p_file_name text, p_file_size bigint, p_file_type text, p_storage_path text, p_retention_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_attachment_id uuid;
  v_expires_at timestamptz;
  v_caller uuid;
  v_retention integer;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT (
    support_is_ticket_requester(p_ticket_id::text)
    OR public.has_permission(v_caller, 'support.view')
  ) THEN
    RAISE EXCEPTION 'Not authorised to attach to this ticket';
  END IF;

  -- Clamp: a caller must not be able to ask for a 100-year retention, and a
  -- zero/negative value would make an upload expire before it is readable.
  v_retention := LEAST(GREATEST(COALESCE(p_retention_days, 30), 1), 90);
  v_expires_at := now() + (v_retention || ' days')::interval;

  INSERT INTO support_ticket_attachments (
    ticket_id, message_id, file_name, file_size, file_type,
    storage_path, uploaded_by, expires_at
  ) VALUES (
    p_ticket_id, NULL, p_file_name, p_file_size, p_file_type,
    p_storage_path, v_caller, v_expires_at
  )
  RETURNING id INTO v_attachment_id;

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, new_value, metadata)
  VALUES (
    p_ticket_id, v_caller, 'diagnostic_attachment_uploaded', p_file_name,
    jsonb_build_object(
      'attachment_id', v_attachment_id,
      'file_size', p_file_size,
      'expires_at', v_expires_at,
      'source', 'support_access_mode'
    )
  );

  RETURN jsonb_build_object(
    'id', v_attachment_id,
    'storage_path', p_storage_path,
    'expires_at', v_expires_at
  );
END;
$function$;

-- support.manage or support.admin
CREATE OR REPLACE FUNCTION public.support_delete_own_attachment(p_attachment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_ticket_id uuid;
  v_file_name text;
  v_storage_path text;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT a.ticket_id, a.file_name, a.storage_path
    INTO v_ticket_id, v_file_name, v_storage_path
  FROM support_ticket_attachments a
  WHERE a.id = p_attachment_id;

  IF v_ticket_id IS NULL THEN
    RETURN jsonb_build_object('deleted', true, 'already_absent', true);
  END IF;

  IF NOT (
    support_is_ticket_requester(v_ticket_id::text)
    OR public.has_any_permission(v_caller, ARRAY['support.manage', 'support.admin'])
  ) THEN
    RAISE EXCEPTION 'Not authorised to delete this attachment';
  END IF;

  -- NO storage.objects DELETE. Supabase rejects direct DML on storage tables,
  -- and the raise aborted this function, stranding the row. The caller removes
  -- the object through the Storage API before calling this.
  DELETE FROM support_ticket_attachments WHERE id = p_attachment_id;

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, metadata)
  VALUES (
    v_ticket_id, v_caller, 'attachment_deleted_by_requester', v_file_name,
    jsonb_build_object('attachment_id', p_attachment_id, 'storage_path', v_storage_path)
  );

  RETURN jsonb_build_object('deleted', true, 'already_absent', false);
END;
$function$;

-- support.view
CREATE OR REPLACE FUNCTION public.support_list_attachments(p_ticket_id uuid)
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
        'id', a.id,
        'ticket_id', a.ticket_id,
        'message_id', a.message_id,
        'file_name', a.file_name,
        'file_size', a.file_size,
        'file_type', a.file_type,
        'storage_path', a.storage_path,
        'uploaded_by', a.uploaded_by,
        'created_at', a.created_at
      ) ORDER BY a.created_at
    )
    FROM support_ticket_attachments a
    WHERE a.ticket_id = p_ticket_id
      AND (
        v_is_internal
        OR a.message_id IS NULL
        OR EXISTS (
          SELECT 1 FROM support_ticket_messages m
          WHERE m.id = a.message_id
            AND m.message_type <> 'internal_note'
        )
      )),
    '[]'::jsonb
  );
END;
$function$;

-- support.view
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
    WHERE e.ticket_id = p_ticket_id),
    '[]'::jsonb
  );
END;
$function$;

-- support.view
CREATE OR REPLACE FUNCTION public.support_record_attachment_access(p_attachment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_ticket_id uuid;
  v_file_name text;
  v_is_internal boolean;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT a.ticket_id, a.file_name INTO v_ticket_id, v_file_name
  FROM support_ticket_attachments a
  WHERE a.id = p_attachment_id;

  IF v_ticket_id IS NULL THEN
    RETURN jsonb_build_object('logged', false, 'reason', 'not_found');
  END IF;

  v_is_internal := public.has_permission(v_caller, 'support.view');

  IF NOT (support_is_ticket_requester(v_ticket_id::text) OR v_is_internal) THEN
    RAISE EXCEPTION 'Not authorised to read this attachment';
  END IF;

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, new_value, metadata)
  VALUES (
    v_ticket_id, v_caller, 'attachment_read', v_file_name,
    jsonb_build_object(
      'attachment_id', p_attachment_id,
      'reader', CASE WHEN v_is_internal THEN 'internal' ELSE 'requester' END
    )
  );

  RETURN jsonb_build_object('logged', true);
END;
$function$;

-- Grants: unchanged.
