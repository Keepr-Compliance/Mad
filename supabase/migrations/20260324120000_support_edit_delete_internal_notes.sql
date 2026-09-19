-- Migration: Add edit/delete capabilities for internal notes on support tickets
-- BACKLOG-1344 / TASK-2315

-- 1. Add edited_at and edited_by columns to support_ticket_messages
ALTER TABLE support_ticket_messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS edited_by UUID DEFAULT NULL REFERENCES auth.users(id);

-- 2. RPC: Edit an internal note (only the author can edit their own internal notes)
CREATE OR REPLACE FUNCTION support_edit_internal_note(
  p_message_id UUID,
  p_body TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message RECORD;
  v_result JSONB;
BEGIN
  -- Fetch the message and verify it exists
  SELECT id, ticket_id, sender_id, message_type, body
    INTO v_message
    FROM support_ticket_messages
   WHERE id = p_message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Message not found';
  END IF;

  -- Verify it is an internal note
  IF v_message.message_type <> 'internal_note' THEN
    RAISE EXCEPTION 'Only internal notes can be edited';
  END IF;

  -- Verify the caller is the original author
  IF v_message.sender_id IS NULL OR v_message.sender_id <> auth.uid() THEN
    RAISE EXCEPTION 'You can only edit your own notes';
  END IF;

  -- Update the message
  UPDATE support_ticket_messages
     SET body = p_body,
         edited_at = now(),
         edited_by = auth.uid(),
         search_vector = to_tsvector('english', p_body)
   WHERE id = p_message_id
  RETURNING jsonb_build_object(
    'id', id,
    'ticket_id', ticket_id,
    'body', body,
    'edited_at', edited_at,
    'edited_by', edited_by
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- 3. RPC: Delete an internal note (only the author can delete their own internal notes)
CREATE OR REPLACE FUNCTION support_delete_internal_note(
  p_message_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message RECORD;
BEGIN
  -- Fetch the message and verify it exists
  SELECT id, ticket_id, sender_id, message_type
    INTO v_message
    FROM support_ticket_messages
   WHERE id = p_message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Message not found';
  END IF;

  -- Verify it is an internal note
  IF v_message.message_type <> 'internal_note' THEN
    RAISE EXCEPTION 'Only internal notes can be deleted';
  END IF;

  -- Verify the caller is the original author
  IF v_message.sender_id IS NULL OR v_message.sender_id <> auth.uid() THEN
    RAISE EXCEPTION 'You can only delete your own notes';
  END IF;

  -- Delete the message
  DELETE FROM support_ticket_messages WHERE id = p_message_id;

  -- Log the deletion event
  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, metadata)
  VALUES (
    v_message.ticket_id,
    auth.uid(),
    'internal_note_deleted',
    'Internal note deleted',
    jsonb_build_object('deleted_message_id', p_message_id)
  );

  RETURN jsonb_build_object(
    'deleted', true,
    'message_id', p_message_id,
    'ticket_id', v_message.ticket_id
  );
END;
$$;

-- 4. Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION support_edit_internal_note(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION support_delete_internal_note(UUID) TO authenticated;
