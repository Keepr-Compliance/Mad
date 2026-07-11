-- GIT<->PROD PARITY MIRROR: this file mirrors the migration already applied to PROD
-- (supabase_migrations.schema_migrations version 20260711072135) via MCP apply_migration
-- on 2026-07-11. DO NOT re-apply — the database already has it. Ref BACKLOG-1955.
-- BACKLOG-1955: Add internal-role guard to 4 SECURITY DEFINER support_* mutators.
-- These functions are EXECUTE-granted to anon/authenticated but did NOT verify the
-- caller's internal role, so any authenticated (or in some cases anon) principal could
-- call them. Guard idiom copied verbatim from the correctly-guarded support siblings
-- support_assign_ticket / support_update_ticket_status:
--     IF v_caller_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN RAISE EXCEPTION ...
-- (This idiom intentionally rejects service_role; support_* mutators are only ever called
--  by authenticated internal agents via the admin/broker portal + Electron desktop, never
--  by service_role CI/hooks.)
-- CREATE OR REPLACE preserves existing EXECUTE grants; grants are NOT changed.

CREATE OR REPLACE FUNCTION public.support_create_template(p_name text, p_body text, p_category text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
  v_caller_id UUID := auth.uid();
BEGIN
  -- AUTH GUARD: Must be authenticated and exist in internal_roles (BACKLOG-1955)
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can create templates' USING ERRCODE = '42501';
  END IF;

  INSERT INTO support_response_templates (name, body, category, created_by, updated_by)
  VALUES (p_name, p_body, p_category, auth.uid(), auth.uid())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'name', p_name);
END;
$function$;

CREATE OR REPLACE FUNCTION public.support_link_tickets(p_ticket_id uuid, p_linked_ticket_id uuid, p_link_type text DEFAULT 'related'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID;
  v_link_id UUID;
  v_ticket_number INTEGER;
  v_linked_number INTEGER;
BEGIN
  v_caller_id := auth.uid();
  -- AUTH GUARD: Must be authenticated and exist in internal_roles (BACKLOG-1955)
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can link tickets' USING ERRCODE = '42501';
  END IF;

  SELECT ticket_number INTO v_ticket_number FROM support_tickets WHERE id = p_ticket_id;
  SELECT ticket_number INTO v_linked_number FROM support_tickets WHERE id = p_linked_ticket_id;

  IF v_ticket_number IS NULL OR v_linked_number IS NULL THEN
    RAISE EXCEPTION 'One or both tickets not found';
  END IF;

  INSERT INTO support_ticket_links (ticket_id, linked_ticket_id, link_type, linked_by)
  VALUES (p_ticket_id, p_linked_ticket_id, p_link_type, v_caller_id)
  RETURNING id INTO v_link_id;

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, new_value)
  VALUES (p_ticket_id, v_caller_id, 'ticket_linked', '#' || v_linked_number || ' (' || p_link_type || ')');

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, new_value)
  VALUES (p_linked_ticket_id, v_caller_id, 'ticket_linked', '#' || v_ticket_number || ' (' || p_link_type || ')');

  RETURN jsonb_build_object('link_id', v_link_id, 'linked', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.support_unlink_tickets(p_ticket_id uuid, p_linked_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID;
  v_ticket_number INTEGER;
  v_linked_number INTEGER;
BEGIN
  v_caller_id := auth.uid();
  -- AUTH GUARD: Must be authenticated and exist in internal_roles (BACKLOG-1955)
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can unlink tickets' USING ERRCODE = '42501';
  END IF;

  SELECT ticket_number INTO v_ticket_number FROM support_tickets WHERE id = p_ticket_id;
  SELECT ticket_number INTO v_linked_number FROM support_tickets WHERE id = p_linked_ticket_id;

  DELETE FROM support_ticket_links
  WHERE (ticket_id = p_ticket_id AND linked_ticket_id = p_linked_ticket_id)
     OR (ticket_id = p_linked_ticket_id AND linked_ticket_id = p_ticket_id);

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value)
  VALUES (p_ticket_id, v_caller_id, 'ticket_unlinked', '#' || v_linked_number);

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value)
  VALUES (p_linked_ticket_id, v_caller_id, 'ticket_unlinked', '#' || v_ticket_number);

  RETURN jsonb_build_object('unlinked', true);
END;
$function$;

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
  -- AUTH GUARD: Must be authenticated and exist in internal_roles (BACKLOG-1955)
  IF v_uploader_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_uploader_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can add attachments' USING ERRCODE = '42501';
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
