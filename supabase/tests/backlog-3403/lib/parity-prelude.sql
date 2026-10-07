-- BACKLOG-3403 venue prelude: the production state of every object the 3403
-- migration touches or reads, transcribed read-only from production on
-- 2026-10-04 (information_schema.columns, pg_constraint, pg_trigger,
-- pg_get_functiondef, pg_policies, information_schema.role_table_grants,
-- storage.buckets). Loaded ONCE, committed, into a fresh local stack
-- (`supabase start`, which brings the real auth and storage schemas). It is not
-- for production.
--
-- Stubbed (not touched by the migration; read only by policies it keeps):
--   public.organizations          id + personal_owner_user_id only
--   public.organization_members   the columns policies read
--   public.internal_roles         id, user_id, role_id (no roles table)
--   public.check_feature_access   members -> {"allowed": true}
-- Control e00 compares this venue's fingerprint (lib/fp-3403.sql) with the
-- production result pinned in lib/fixtures-3403.sql.

CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  personal_owner_user_id uuid NULL
);
CREATE TABLE IF NOT EXISTS public.organization_members (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NULL,
  role character varying(50) NOT NULL
);
CREATE TABLE IF NOT EXISTS public.internal_roles (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  role_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now()
);
GRANT SELECT ON public.organizations, public.organization_members TO authenticated;

CREATE OR REPLACE FUNCTION public.can_review_submission(p_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.organization_members om
     WHERE om.organization_id = p_org_id
       AND om.user_id = (SELECT auth.uid())
       AND om.role IN ('broker', 'admin', 'it_admin')
  );
$function$;

CREATE OR REPLACE FUNCTION public.check_feature_access(p_org_id uuid, p_feature_key text)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
  SELECT jsonb_build_object('allowed', EXISTS (SELECT 1 FROM public.organization_members m
                                                 WHERE m.user_id = auth.uid() AND m.organization_id = p_org_id));
$function$;

-- Tables (columns and constraints verbatim).
CREATE TABLE IF NOT EXISTS public.transaction_submissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, submitted_by uuid NOT NULL,
  local_transaction_id text NOT NULL, property_address text NOT NULL, property_city text, property_state text,
  property_zip text, transaction_type character varying(50), listing_price numeric, sale_price numeric,
  started_at timestamp with time zone, closed_at timestamp with time zone,
  status character varying(50) DEFAULT 'submitted'::character varying, reviewed_by uuid,
  reviewed_at timestamp with time zone, review_notes text, version integer DEFAULT 1, parent_submission_id uuid,
  review_deadline timestamp with time zone, message_count integer DEFAULT 0, attachment_count integer DEFAULT 0,
  submission_metadata jsonb, created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(), status_history jsonb DEFAULT '[]'::jsonb,
  commission_offered_rate numeric, commission_actual_rate numeric, commission_gross_amount numeric,
  commission_adjustment_reason text,
  CONSTRAINT transaction_submissions_pkey PRIMARY KEY (id),
  CONSTRAINT transaction_submissions_org_txn_version_user_key UNIQUE (organization_id, local_transaction_id, version, submitted_by),
  CONSTRAINT transaction_submissions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT transaction_submissions_parent_submission_id_fkey FOREIGN KEY (parent_submission_id) REFERENCES public.transaction_submissions(id),
  CONSTRAINT transaction_submissions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id),
  CONSTRAINT transaction_submissions_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES auth.users(id),
  CONSTRAINT transaction_submissions_actual_rate_check CHECK (((commission_actual_rate IS NULL) OR ((commission_actual_rate >= (0)::numeric) AND (commission_actual_rate <= (100)::numeric)))),
  CONSTRAINT transaction_submissions_adjustment_reason_check CHECK (((commission_adjustment_reason IS NULL) OR ((char_length(btrim(commission_adjustment_reason)) >= 1) AND (char_length(btrim(commission_adjustment_reason)) <= 2000)))),
  CONSTRAINT transaction_submissions_gross_amount_check CHECK (((commission_gross_amount IS NULL) OR (commission_gross_amount >= (0)::numeric))),
  CONSTRAINT transaction_submissions_offered_rate_check CHECK (((commission_offered_rate IS NULL) OR ((commission_offered_rate >= (0)::numeric) AND (commission_offered_rate <= (100)::numeric)))),
  CONSTRAINT transaction_submissions_status_check CHECK (((status)::text = ANY (ARRAY['uploading'::text, 'submitted'::text, 'under_review'::text, 'needs_changes'::text, 'resubmitted'::text, 'approved'::text, 'rejected'::text]))),
  CONSTRAINT transaction_submissions_transaction_type_check CHECK (((transaction_type)::text = ANY ((ARRAY['purchase'::character varying, 'sale'::character varying, 'other'::character varying])::text[])))
);
CREATE TABLE IF NOT EXISTS public.submission_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(), submission_id uuid NOT NULL, local_message_id text,
  channel character varying(50), direction character varying(50), subject text, body_text text, participants jsonb,
  sent_at timestamp with time zone, thread_id text, has_attachments boolean DEFAULT false,
  attachment_count integer DEFAULT 0, created_at timestamp with time zone DEFAULT now(), message_type text,
  CONSTRAINT submission_messages_pkey PRIMARY KEY (id),
  CONSTRAINT submission_messages_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES public.transaction_submissions(id) ON DELETE CASCADE,
  CONSTRAINT submission_messages_channel_check CHECK (((channel)::text = ANY ((ARRAY['email'::character varying, 'sms'::character varying, 'imessage'::character varying])::text[]))),
  CONSTRAINT submission_messages_direction_check CHECK (((direction)::text = ANY ((ARRAY['inbound'::character varying, 'outbound'::character varying])::text[])))
);
CREATE TABLE IF NOT EXISTS public.submission_attachments (
  id uuid NOT NULL DEFAULT gen_random_uuid(), submission_id uuid NOT NULL, message_id uuid,
  filename character varying(255) NOT NULL, mime_type character varying(100), file_size_bytes integer,
  storage_path text NOT NULL, document_type character varying(50), created_at timestamp with time zone DEFAULT now(),
  local_attachment_id text,
  CONSTRAINT submission_attachments_pkey PRIMARY KEY (id),
  CONSTRAINT submission_attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.submission_messages(id) ON DELETE SET NULL,
  CONSTRAINT submission_attachments_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES public.transaction_submissions(id) ON DELETE CASCADE,
  CONSTRAINT submission_attachments_document_type_check CHECK (((document_type)::text = ANY ((ARRAY['offer'::character varying, 'inspection'::character varying, 'disclosure'::character varying, 'contract'::character varying, 'appraisal'::character varying, 'amendment'::character varying, 'addendum'::character varying, 'title'::character varying, 'closing'::character varying, 'correspondence'::character varying, 'other'::character varying])::text[])))
);
CREATE TABLE IF NOT EXISTS public.submission_checklists (
  id uuid NOT NULL DEFAULT gen_random_uuid(), submission_id uuid NOT NULL, template_name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(), sort_order integer NOT NULL DEFAULT 0, template_id uuid,
  added_at_review_by uuid, added_at_review_at timestamp with time zone, removed_at_review_by uuid,
  removed_at_review_at timestamp with time zone, restored_from_checklist_id uuid,
  CONSTRAINT submission_checklists_pkey PRIMARY KEY (id),
  CONSTRAINT submission_checklists_id_submission_id_key UNIQUE (id, submission_id),
  CONSTRAINT submission_checklists_restored_from_checklist_id_fkey FOREIGN KEY (restored_from_checklist_id) REFERENCES public.submission_checklists(id) ON DELETE SET NULL,
  CONSTRAINT submission_checklists_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES public.transaction_submissions(id) ON DELETE CASCADE,
  CONSTRAINT submission_checklists_added_at_review_pair_check CHECK (((added_at_review_by IS NULL) = (added_at_review_at IS NULL))),
  CONSTRAINT submission_checklists_removed_pair_check CHECK (((removed_at_review_by IS NULL) = (removed_at_review_at IS NULL)))
);

CREATE INDEX IF NOT EXISTS idx_submission_attachments_message_id ON public.submission_attachments USING btree (message_id);
CREATE INDEX IF NOT EXISTS idx_submission_messages_sent_at ON public.submission_messages USING btree (sent_at);

-- Grants (verbatim).
REVOKE ALL ON public.transaction_submissions, public.submission_messages, public.submission_attachments, public.submission_checklists FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.transaction_submissions, public.submission_messages, public.submission_attachments TO anon, authenticated;
GRANT INSERT, SELECT ON public.submission_checklists TO authenticated;
GRANT ALL ON public.transaction_submissions, public.submission_messages, public.submission_attachments, public.submission_checklists TO service_role;

-- Trigger functions and triggers (verbatim).
CREATE OR REPLACE FUNCTION public.guard_commission_figures_locked()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO ''
AS $function$
DECLARE
  v_role text := auth.role();
BEGIN
  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF v_role IS NULL AND current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF NEW.commission_offered_rate IS DISTINCT FROM OLD.commission_offered_rate THEN
    RAISE EXCEPTION 'commission_figures_locked: commission_offered_rate'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.commission_actual_rate IS DISTINCT FROM OLD.commission_actual_rate THEN
    RAISE EXCEPTION 'commission_figures_locked: commission_actual_rate'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.commission_gross_amount IS DISTINCT FROM OLD.commission_gross_amount THEN
    RAISE EXCEPTION 'commission_figures_locked: commission_gross_amount'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.commission_adjustment_reason IS DISTINCT FROM OLD.commission_adjustment_reason THEN
    RAISE EXCEPTION 'commission_figures_locked: commission_adjustment_reason'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.guard_status_history_append_only()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO ''
AS $function$
DECLARE
  v_role    text := auth.role();
  v_old     jsonb;
  v_new     jsonb := NEW.status_history;
  v_old_len integer;
  v_new_len integer;
  v_elem    jsonb;
  i         integer;
BEGIN
  IF v_role IS NULL OR v_role = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_new IS NOT NULL AND v_new <> '[]'::jsonb THEN
      RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF current_user IN ('authenticated', 'anon') THEN
    -- Review fields: a reviewer of the row's current organization, naming
    -- itself.
    IF NEW.reviewed_by     IS DISTINCT FROM OLD.reviewed_by
       OR NEW.reviewed_at  IS DISTINCT FROM OLD.reviewed_at
       OR NEW.review_notes IS DISTINCT FROM OLD.review_notes THEN
      IF NOT public.can_review_submission(OLD.organization_id) THEN
        RAISE EXCEPTION 'review_fields_reviewer_only' USING ERRCODE = '42501';
      END IF;
      IF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
         AND NEW.reviewed_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'review_fields_reviewer_only' USING ERRCODE = '42501';
      END IF;
    END IF;
    -- Ownership columns are fixed for a client statement.
    IF NEW.id                      IS DISTINCT FROM OLD.id
       OR NEW.organization_id      IS DISTINCT FROM OLD.organization_id
       OR NEW.submitted_by         IS DISTINCT FROM OLD.submitted_by
       OR NEW.local_transaction_id IS DISTINCT FROM OLD.local_transaction_id
       OR NEW.parent_submission_id IS DISTINCT FROM OLD.parent_submission_id
       OR NEW.version              IS DISTINCT FROM OLD.version THEN
      RAISE EXCEPTION 'submission_owner_fields_locked' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.status_history IS NOT DISTINCT FROM OLD.status_history THEN
    RETURN NEW;
  END IF;

  -- A client statement may not change the history at all.
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';
  END IF;

  v_old := COALESCE(OLD.status_history, '[]'::jsonb);
  IF jsonb_typeof(v_old) <> 'array' THEN
    v_old := '[]'::jsonb;
  END IF;
  IF v_new IS NULL OR jsonb_typeof(v_new) <> 'array' THEN
    RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';
  END IF;

  v_old_len := jsonb_array_length(v_old);
  v_new_len := jsonb_array_length(v_new);

  -- Every existing entry must still be there, unchanged, at the same index.
  -- (A shorter array fails here too: the missing index reads as NULL.)
  FOR i IN 0 .. v_old_len - 1 LOOP
    IF (v_new -> i) IS DISTINCT FROM (v_old -> i) THEN
      RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- Every appended entry must be a typed object naming the caller.
  FOR i IN v_old_len .. v_new_len - 1 LOOP
    v_elem := v_new -> i;
    IF jsonb_typeof(v_elem) <> 'object'
       OR NOT (v_elem ? 'type')
       OR lower(COALESCE(v_elem ->> 'changed_by', '')) IS DISTINCT FROM COALESCE(auth.uid()::text, '-') THEN
      RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.track_submission_status_changes()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_history = COALESCE(NEW.status_history, '[]'::jsonb) || jsonb_build_object(
      'status', NEW.status,
      'changed_at', NOW(),
      'changed_by', NEW.reviewed_by,
      'notes', NEW.review_notes
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

-- Function ACLs (production proacl).
REVOKE ALL ON FUNCTION public.can_review_submission(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_review_submission(uuid) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_status_history_append_only() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_status_history_append_only() TO service_role;

DROP TRIGGER IF EXISTS commission_figures_locked ON public.transaction_submissions;
CREATE TRIGGER commission_figures_locked BEFORE UPDATE OF commission_offered_rate, commission_actual_rate, commission_gross_amount, commission_adjustment_reason ON public.transaction_submissions FOR EACH ROW EXECUTE FUNCTION guard_commission_figures_locked();
DROP TRIGGER IF EXISTS status_history_append_only ON public.transaction_submissions;
CREATE TRIGGER status_history_append_only BEFORE INSERT OR UPDATE ON public.transaction_submissions FOR EACH ROW EXECUTE FUNCTION guard_status_history_append_only();
DROP TRIGGER IF EXISTS track_status_changes ON public.transaction_submissions;
CREATE TRIGGER track_status_changes BEFORE UPDATE ON public.transaction_submissions FOR EACH ROW EXECUTE FUNCTION track_submission_status_changes();
DROP TRIGGER IF EXISTS update_submissions_updated_at ON public.transaction_submissions;
CREATE TRIGGER update_submissions_updated_at BEFORE UPDATE ON public.transaction_submissions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS (verbatim from pg_policies).
ALTER TABLE public.transaction_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submission_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submission_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submission_checklists ENABLE ROW LEVEL SECURITY;

CREATE POLICY agents_can_create_submissions ON public.transaction_submissions FOR INSERT WITH CHECK (((submitted_by = ( SELECT auth.uid() AS uid)) AND (organization_id IN ( SELECT om.organization_id
   FROM (organization_members om
     JOIN organizations o ON ((o.id = om.organization_id)))
  WHERE ((om.user_id = ( SELECT auth.uid() AS uid)) AND (o.personal_owner_user_id IS NULL)))) AND ((status)::text = ANY (ARRAY['uploading'::text, 'submitted'::text])) AND (reviewed_by IS NULL) AND (reviewed_at IS NULL) AND (review_notes IS NULL)));
CREATE POLICY agents_can_delete_stale_uploads ON public.transaction_submissions FOR DELETE USING (((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text)));
CREATE POLICY service_role_full_access_submissions ON public.transaction_submissions FOR ALL USING ((auth.role() = 'service_role'::text));
CREATE POLICY transaction_submissions_select_public ON public.transaction_submissions FOR SELECT USING (((submitted_by = ( SELECT auth.uid() AS uid)) OR can_review_submission(organization_id)));
CREATE POLICY transaction_submissions_update_public ON public.transaction_submissions FOR UPDATE USING ((((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text)) OR (((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text])) AND (organization_id IN ( SELECT organization_members.organization_id
   FROM organization_members
  WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text])))))))) WITH CHECK ((((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['resubmitted'::text, 'uploading'::text, 'submitted'::text]))) OR (organization_id IN ( SELECT organization_members.organization_id
   FROM organization_members
  WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text])))))));

CREATE POLICY agents_can_insert_messages ON public.submission_messages FOR INSERT WITH CHECK ((submission_id IN ( SELECT transaction_submissions.id
   FROM transaction_submissions
  WHERE (transaction_submissions.submitted_by = ( SELECT auth.uid() AS uid)))));
CREATE POLICY message_access_via_submission ON public.submission_messages FOR SELECT USING ((EXISTS ( SELECT 1
   FROM transaction_submissions ts
  WHERE ((ts.id = submission_messages.submission_id) AND ((ts.submitted_by = ( SELECT auth.uid() AS uid)) OR can_review_submission(ts.organization_id))))));
CREATE POLICY service_role_full_access_messages ON public.submission_messages FOR ALL USING ((auth.role() = 'service_role'::text));

CREATE POLICY agents_can_delete_own_attachments ON public.submission_attachments FOR DELETE USING ((submission_id IN ( SELECT transaction_submissions.id
   FROM transaction_submissions
  WHERE ((transaction_submissions.submitted_by = ( SELECT auth.uid() AS uid)) AND ((transaction_submissions.status)::text = 'uploading'::text)))));
CREATE POLICY agents_can_insert_attachments ON public.submission_attachments FOR INSERT WITH CHECK ((submission_id IN ( SELECT transaction_submissions.id
   FROM transaction_submissions
  WHERE (transaction_submissions.submitted_by = ( SELECT auth.uid() AS uid)))));
CREATE POLICY attachment_access_via_submission ON public.submission_attachments FOR SELECT USING ((EXISTS ( SELECT 1
   FROM transaction_submissions ts
  WHERE ((ts.id = submission_attachments.submission_id) AND ((ts.submitted_by = ( SELECT auth.uid() AS uid)) OR can_review_submission(ts.organization_id))))));
CREATE POLICY service_role_full_access_attachments ON public.submission_attachments FOR ALL USING ((auth.role() = 'service_role'::text));

CREATE POLICY submission_checklists_insert ON public.submission_checklists FOR INSERT TO authenticated WITH CHECK (((added_at_review_by IS NULL) AND (added_at_review_at IS NULL) AND (removed_at_review_by IS NULL) AND (removed_at_review_at IS NULL) AND (restored_from_checklist_id IS NULL) AND (EXISTS ( SELECT 1
   FROM transaction_submissions ts
  WHERE ((ts.id = submission_checklists.submission_id) AND (ts.submitted_by = ( SELECT auth.uid() AS uid)) AND ((ts.status)::text = 'uploading'::text) AND COALESCE(((check_feature_access(ts.organization_id, 'transaction_checklists'::text) ->> 'allowed'::text))::boolean, false))))));
CREATE POLICY submission_checklists_select ON public.submission_checklists FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM transaction_submissions ts
  WHERE ((ts.id = submission_checklists.submission_id) AND ((ts.submitted_by = ( SELECT auth.uid() AS uid)) OR can_review_submission(ts.organization_id))))));

-- Storage: the bucket and its policies (verbatim).
INSERT INTO storage.buckets (id, name, public) VALUES ('submission-attachments', 'submission-attachments', false)
  ON CONFLICT (id) DO NOTHING;
CREATE POLICY "Members can upload submission attachments" ON storage.objects FOR INSERT WITH CHECK (((bucket_id = 'submission-attachments'::text) AND (split_part(name, '/'::text, 1) IN ( SELECT (om.organization_id)::text AS organization_id
   FROM (organization_members om
     JOIN organizations o ON ((o.id = om.organization_id)))
  WHERE ((om.user_id = auth.uid()) AND (o.personal_owner_user_id IS NULL))))));
CREATE POLICY "Submission attachments follow their submission" ON storage.objects FOR SELECT USING (((bucket_id = 'submission-attachments'::text) AND (EXISTS ( SELECT 1
   FROM transaction_submissions s
  WHERE ((s.id =
        CASE
            WHEN (split_part(objects.name, '/'::text, 2) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text) THEN (split_part(objects.name, '/'::text, 2))::uuid
            ELSE NULL::uuid
        END) AND ((s.organization_id)::text = split_part(objects.name, '/'::text, 1)))))));

NOTIFY pgrst, 'reload schema';
