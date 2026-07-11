-- GIT<->PROD PARITY MIRROR: this file mirrors the migration already applied to PROD
-- (supabase_migrations.schema_migrations version 20260711072207) via MCP apply_migration
-- on 2026-07-11. DO NOT re-apply — the database already has it. Ref BACKLOG-1955.
-- BACKLOG-1955 CORRECTION: Revert the internal-role guard on support_add_attachment.
-- Unlike the other 3 support_* mutators (admin-portal / internal-agent only), this
-- function is CUSTOMER-FACING: it is invoked by external brokers and desktop end-users
-- (broker-portal CustomerReplyForm/TicketForm/SupportWidget, electron supportTicketHandlers)
-- to attach files to THEIR OWN support tickets. Those callers are NOT in internal_roles,
-- so an internal-role guard would break legitimate uploads. Restoring the original body;
-- this function needs a different authorization approach (e.g. ticket-ownership check),
-- tracked separately.
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

  INSERT INTO support_ticket_attachments (
    ticket_id, message_id, file_name, file_size, file_type, storage_path, uploaded_by
  ) VALUES (
    p_ticket_id, p_message_id, p_file_name, p_file_size, p_file_type, p_storage_path, v_uploader_id
  )
  RETURNING id INTO v_attachment_id;

  RETURN jsonb_build_object('id', v_attachment_id, 'storage_path', p_storage_path);
END;
$function$;
