-- GIT<->PROD PARITY MIRROR: this file mirrors the migration already applied to PROD
-- (supabase_migrations.schema_migrations version 20260803105306) via MCP apply_migration
-- on 2026-08-03. DO NOT re-apply -- the database already has it.
-- BACKLOG-2412: bring the two support-attachment RPCs in line with the
-- authorization the rest of the attachment stack already enforces.
--
-- THE RULE: both permit the ticket requester and internal staff. Nobody else.
--
-- This is not a new policy. It is the rule already applied to the file bytes:
-- the storage.objects policies "Customers can read own ticket attachments" and
-- "Customers can upload to own tickets" require support_is_ticket_requester(...),
-- and agents need internal_roles. Downloads were already requester-or-internal;
-- these two SECURITY DEFINER functions are the paths that had not yet been
-- aligned with it. This settles three paths on one rule rather than adding a
-- fourth. The storage.objects policies are correct and are NOT touched here.
--
-- WHY THE 2026-07-11 REVERT DOES NOT RECUR
-- 20260711072135_security_guard_support_agent_ops.sql (BACKLOG-1955) guarded
-- this same function with an internal-role-ONLY check, batched together with
-- three genuinely agent-only mutators. It was reverted the same day
-- (20260711072207) because this one is CUSTOMER-FACING: broker-portal
-- TicketForm/CustomerReplyForm/SupportWidget, electron supportTicketHandlers
-- and the android companion call it so customers can attach files to THEIR OWN
-- tickets, and customers are not in internal_roles. Every customer upload was
-- rejected with 42501.
--
-- The rule below admits exactly the path that guard omitted: requester OR
-- internal. The internal-only guard is not re-introduced.
--
-- Nor can this reject a call that works today. All callers upload to storage
-- FIRST and register the row only afterwards, and the storage INSERT policy
-- already requires auth.uid() IS NOT NULL AND support_is_ticket_requester(...)
-- (or internal_roles). A successful upload therefore already proves
-- requester-or-internal; the same predicate on the RPC that follows cannot
-- refuse what the preceding step accepted. The anonymous branch of
-- support_create_ticket (auth.uid() IS NULL) is not a counterexample: that
-- storage policy requires auth.uid() IS NOT NULL, so an anonymous submission
-- cannot produce an attachment today either. There is no service-role or edge
-- function caller.
--
-- Predicate: support_is_ticket_requester(p_ticket_id::text) is reused rather
-- than restated. It resolves the email via auth.users exactly as the table's
-- own SELECT policy and the storage.objects policies do, and is what the
-- BACKLOG-2393 siblings (support_add_diagnostic_attachment,
-- support_delete_own_attachment) already call. One helper for every path is the
-- point -- two authorization rules for one resource is how they drift.

-- ----------------------------------------------------------------------------
-- 1. support_list_attachments -- gate, then filter.
--
-- On refusal this returns an EMPTY LIST, not an error. An error distinguishes
-- "this ticket exists but is not yours" from "no such ticket", which leaks
-- existence to anyone who obtained an id. Empty leaks nothing.
--
-- The row filter mirrors the table's own SELECT policy
-- (support_ticket_attachments_select_public) so the internal-notes distinction
-- is preserved rather than flattened by the outer check: an internal role sees
-- every row; a requester sees rows that are not tied to an internal note.
--
-- Return shape is unchanged (same keys, same created_at ordering).
-- ----------------------------------------------------------------------------
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

  -- Unauthenticated: nothing to authorize against.
  IF v_caller IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  v_is_internal := EXISTS (
    SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller
  );

  -- Neither the requester nor internal staff: empty, not an error.
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
      -- Internal-notes distinction, as enforced by the table's RLS policy.
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

-- ----------------------------------------------------------------------------
-- 2. support_add_attachment -- gate, loudly.
--
-- Failing loudly is correct here: an upload the user is silently not told was
-- rejected is worse than an error. auth.uid() continues to populate
-- uploaded_by, and now also gates.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_add_attachment(
  p_ticket_id uuid,
  p_message_id uuid DEFAULT NULL::uuid,
  p_file_name text DEFAULT ''::text,
  p_file_size bigint DEFAULT 0,
  p_file_type text DEFAULT ''::text,
  p_storage_path text DEFAULT ''::text
)
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

  -- Requester or internal. NOT internal-only -- see the BACKLOG-1955 revert
  -- note above; this is the customer upload path.
  IF NOT (
    support_is_ticket_requester(p_ticket_id::text)
    OR EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_uploader_id)
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

-- Execute grants are unchanged (authenticated); the gate is inside the body.
