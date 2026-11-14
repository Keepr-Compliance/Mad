-- ============================================================================
-- Migration: cloud auto-save tables, storage bucket and functions (BACKLOG-4236, PR-1)
--
-- Tables (RLS on; SELECT for the owner only; no INSERT, UPDATE or DELETE for client roles):
--   cloud_autosave_settings, member_addons, cloud_deals, cloud_deal_parties,
--   cloud_deal_checklists, cloud_deal_checklist_items, cloud_deal_messages, cloud_blobs,
--   cloud_deal_files
-- Bucket: cloud-deal-files (private, 50 MB per object, path <user id>/<blob id>).
--   Storage policies: owner INSERT of a registered, not uploaded, unfenced blob while entitled;
--   owner SELECT of an unfenced blob. No UPDATE or DELETE policy for this bucket.
-- Deals are keyed on (owner_user_id, source_install_id, local_transaction_id). source_install_id
--   is created by the desktop once per local database. Child rows are keyed under their deal.
-- Functions (search_path ''; EXECUTE revoked from PUBLIC, anon, authenticated and service_role,
--   then granted to the one role that calls it):
--   authenticated: cloud_autosave_entitled, get_my_cloud_autosave_state, set_my_cloud_autosave,
--     cloud_list_installs, cloud_delete_install, cloud_upsert_deal, cloud_upsert_parties,
--     cloud_upsert_checklists, cloud_upsert_checklist_items, cloud_upsert_messages,
--     cloud_upsert_files, cloud_register_blob, cloud_confirm_blob, cloud_tombstone,
--     cloud_delete_deal, cloud_mark_deal_synced
--   service_role: assign_member_addon
--   no API role: _cloud_autosave_license, _cloud_autosave_current_notice_version,
--     _cloud_bad_field, _cloud_row_status, _cloud_fence_unreferenced
-- Every client write takes p_expected_user_id uuid as its first argument and returns error
--   'wrong_account', with no write, when it differs from auth.uid(): set_my_cloud_autosave,
--   cloud_delete_install, cloud_upsert_deal, cloud_upsert_parties, cloud_upsert_checklists,
--   cloud_upsert_checklist_items, cloud_upsert_messages, cloud_upsert_files, cloud_tombstone,
--   cloud_delete_deal, cloud_mark_deal_synced, cloud_register_blob, cloud_confirm_blob. Each one's
--   earlier signature (without that argument) is dropped right before the new one is created.
-- A file row attaches only an uploaded, unfenced blob of the caller and only a live message.
-- cloud_deal_parties.details_withheld (from the row, default false): when true, cloud_upsert_parties stores
--   display_name, company, emails and phones as NULL. contact_source is stored as sent.
-- Freshness: each write reads clock_timestamp() once, after its deal row lock, and sets
--   last_synced_at = greatest(last_synced_at, <that value>); cloud_mark_deal_synced sets
--   last_full_sync_at and last_synced_at to one such value.
-- Lock order in every write: the caller's settings row, then deals (id order), then blobs (id order,
--   all of a call's blobs in one statement), then child rows of the locked deals. Tombstones and
--   deletes fence blobs once, after their rows, through _cloud_fence_unreferenced (id order).
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS.
-- ============================================================================

-- ============================================================================ tables
CREATE TABLE IF NOT EXISTS public.cloud_autosave_settings (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled        boolean NOT NULL DEFAULT false,
  notice_version integer NULL,
  accepted_at    timestamptz NULL,
  enabled_at     timestamptz NULL,
  disabled_at    timestamptz NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.member_addons (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id   uuid NOT NULL REFERENCES public.organization_members(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  addon_key       text NOT NULL CHECK (addon_key IN ('cloud_autosave')),
  source          text NOT NULL CHECK (source IN ('staff', 'admin', 'billing')),
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  assigned_by     uuid NULL,
  ends_at         timestamptz NULL,
  revoked_at      timestamptz NULL,
  revoked_by      uuid NULL,
  CONSTRAINT member_addons_member_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES public.organization_members(organization_id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS member_addons_live_uq ON public.member_addons (membership_id, addon_key) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS member_addons_user_idx ON public.member_addons (user_id);
CREATE INDEX IF NOT EXISTS member_addons_member_idx ON public.member_addons (organization_id, user_id);

CREATE TABLE IF NOT EXISTS public.cloud_deals (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_install_id          uuid NOT NULL,
  local_transaction_id       text NOT NULL CHECK (length(local_transaction_id) BETWEEN 1 AND 200),
  organization_id            uuid NULL REFERENCES public.organizations(id) ON DELETE SET NULL,
  property_address           text NULL,
  property_street            text NULL,
  property_city              text NULL,
  property_state             text NULL,
  property_zip               text NULL,
  transaction_type           text NULL,
  status                     text NULL,
  started_at                 timestamptz NULL,
  closed_at                  timestamptz NULL,
  detection_status           text NULL,
  detection_source           text NULL,
  detection_confidence       double precision NULL,
  detection_method           text NULL,
  reviewed_at                timestamptz NULL,
  local_created_at           timestamptz NULL,
  lock_reason                text NULL,
  texts_outside_window_count integer NULL,
  details                    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  is_confirmed               boolean NOT NULL DEFAULT true,
  content_hash               text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  version                    bigint NOT NULL DEFAULT 1,
  origin                     text NOT NULL DEFAULT 'desktop' CHECK (origin IN ('desktop', 'cloud_user', 'ai_app')),
  source_updated_at          timestamptz NULL,
  last_change_request_id     uuid NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  last_synced_at             timestamptz NOT NULL DEFAULT now(),
  last_full_sync_at          timestamptz NULL,
  CONSTRAINT cloud_deals_local_uq UNIQUE (owner_user_id, source_install_id, local_transaction_id),
  CONSTRAINT cloud_deals_id_owner_uq UNIQUE (id, owner_user_id)
);
CREATE INDEX IF NOT EXISTS cloud_deals_owner_updated_idx ON public.cloud_deals (owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS cloud_deals_owner_install_idx ON public.cloud_deals (owner_user_id, source_install_id);
CREATE INDEX IF NOT EXISTS cloud_deals_org_idx ON public.cloud_deals (organization_id);

CREATE TABLE IF NOT EXISTS public.cloud_deal_parties (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id          uuid NOT NULL,
  cloud_deal_id          uuid NOT NULL,
  local_party_id         text NOT NULL CHECK (length(local_party_id) BETWEEN 1 AND 200),
  local_contact_id       text NULL,
  role                   text NULL,
  role_category          text NULL,
  specific_role          text NULL,
  is_primary             boolean NULL,
  notes                  text NULL,
  display_name           text NULL,
  company                text NULL,
  emails                 jsonb NULL CHECK (emails IS NULL OR jsonb_typeof(emails) = 'array'),
  phones                 jsonb NULL CHECK (phones IS NULL OR jsonb_typeof(phones) = 'array'),
  contact_source         text NULL,
  details_withheld       boolean NOT NULL DEFAULT false,
  contact_deleted        boolean NOT NULL DEFAULT false,
  removed_reason         text NULL,
  content_hash           text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  version                bigint NOT NULL DEFAULT 1,
  origin                 text NOT NULL DEFAULT 'desktop' CHECK (origin IN ('desktop', 'cloud_user', 'ai_app')),
  source_updated_at      timestamptz NULL,
  last_change_request_id uuid NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  removed_at             timestamptz NULL,
  CONSTRAINT cloud_deal_parties_deal_fk FOREIGN KEY (cloud_deal_id, owner_user_id)
    REFERENCES public.cloud_deals(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT cloud_deal_parties_local_uq UNIQUE (cloud_deal_id, local_party_id)
);
-- Added after the first apply of this file: a re-run over an existing table gets the column (existing rows false).
ALTER TABLE public.cloud_deal_parties ADD COLUMN IF NOT EXISTS details_withheld boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS cloud_deal_parties_owner_idx ON public.cloud_deal_parties (owner_user_id);

CREATE TABLE IF NOT EXISTS public.cloud_deal_checklists (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id          uuid NOT NULL,
  cloud_deal_id          uuid NOT NULL,
  local_checklist_id     text NOT NULL CHECK (length(local_checklist_id) BETWEEN 1 AND 200),
  template_id            text NOT NULL,
  template_name          text NULL,
  sort_order             integer NULL,
  selected_at            timestamptz NULL,
  is_private             boolean NOT NULL DEFAULT false,
  content_hash           text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  version                bigint NOT NULL DEFAULT 1,
  origin                 text NOT NULL DEFAULT 'desktop' CHECK (origin IN ('desktop', 'cloud_user', 'ai_app')),
  source_updated_at      timestamptz NULL,
  last_change_request_id uuid NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  removed_at             timestamptz NULL,
  CONSTRAINT cloud_deal_checklists_deal_fk FOREIGN KEY (cloud_deal_id, owner_user_id)
    REFERENCES public.cloud_deals(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT cloud_deal_checklists_local_uq UNIQUE (cloud_deal_id, local_checklist_id),
  CONSTRAINT cloud_deal_checklists_id_deal_uq UNIQUE (id, cloud_deal_id)
);
CREATE INDEX IF NOT EXISTS cloud_deal_checklists_owner_idx ON public.cloud_deal_checklists (owner_user_id);

CREATE TABLE IF NOT EXISTS public.cloud_deal_checklist_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id          uuid NOT NULL,
  cloud_deal_id          uuid NOT NULL,
  cloud_checklist_id     uuid NOT NULL,
  local_item_id          text NOT NULL CHECK (length(local_item_id) BETWEEN 1 AND 200),
  title                  text NULL,
  description            text NULL,
  is_required            boolean NULL,
  expected_document_type text NULL,
  is_checked             boolean NULL,
  checked_at             timestamptz NULL,
  note                   text NULL,
  sort_order             integer NULL,
  local_created_at       timestamptz NULL,
  links                  jsonb NULL CHECK (links IS NULL OR jsonb_typeof(links) = 'array'),
  is_private             boolean NOT NULL DEFAULT false,
  content_hash           text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  version                bigint NOT NULL DEFAULT 1,
  origin                 text NOT NULL DEFAULT 'desktop' CHECK (origin IN ('desktop', 'cloud_user', 'ai_app')),
  source_updated_at      timestamptz NULL,
  last_change_request_id uuid NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  removed_at             timestamptz NULL,
  CONSTRAINT cloud_deal_checklist_items_deal_fk FOREIGN KEY (cloud_deal_id, owner_user_id)
    REFERENCES public.cloud_deals(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT cloud_deal_checklist_items_checklist_fk FOREIGN KEY (cloud_checklist_id, cloud_deal_id)
    REFERENCES public.cloud_deal_checklists(id, cloud_deal_id) ON DELETE CASCADE,
  CONSTRAINT cloud_deal_checklist_items_local_uq UNIQUE (cloud_deal_id, local_item_id)
);
CREATE INDEX IF NOT EXISTS cloud_deal_checklist_items_owner_idx ON public.cloud_deal_checklist_items (owner_user_id);
CREATE INDEX IF NOT EXISTS cloud_deal_checklist_items_checklist_idx ON public.cloud_deal_checklist_items (cloud_checklist_id, cloud_deal_id);

CREATE TABLE IF NOT EXISTS public.cloud_deal_messages (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id          uuid NOT NULL,
  cloud_deal_id          uuid NOT NULL,
  channel_kind           text NOT NULL CHECK (channel_kind IN ('email', 'text')),
  local_message_id       text NOT NULL CHECK (length(local_message_id) BETWEEN 1 AND 200),
  local_link_id          text NULL,
  channel                text NULL CHECK (channel IN ('email', 'sms', 'imessage')),
  direction              text NULL,
  subject                text NULL,
  body_text              text NULL CHECK (body_text IS NULL OR char_length(body_text) <= 1000000),
  body_truncated         boolean NOT NULL DEFAULT false,
  participants           jsonb NULL,
  thread_key             text NULL,
  sent_at                timestamptz NULL,
  received_at            timestamptz NULL,
  link_source            text NULL,
  link_confidence        double precision NULL,
  match_reason           text NULL,
  linked_at              timestamptz NULL,
  link_origin            text NOT NULL DEFAULT 'link' CHECK (link_origin IN ('link', 'review_queue')),
  link_state             text NOT NULL DEFAULT 'linked' CHECK (link_state IN ('linked', 'needs_review', 'suggested')),
  hidden_from_export     boolean NOT NULL DEFAULT false,
  content_hash           text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  version                bigint NOT NULL DEFAULT 1,
  origin                 text NOT NULL DEFAULT 'desktop' CHECK (origin IN ('desktop', 'cloud_user', 'ai_app')),
  source_updated_at      timestamptz NULL,
  last_change_request_id uuid NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  removed_at             timestamptz NULL,
  CONSTRAINT cloud_deal_messages_text_thread_ck CHECK (channel_kind <> 'text' OR thread_key IS NOT NULL),
  CONSTRAINT cloud_deal_messages_deal_fk FOREIGN KEY (cloud_deal_id, owner_user_id)
    REFERENCES public.cloud_deals(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT cloud_deal_messages_local_uq UNIQUE (cloud_deal_id, channel_kind, local_message_id),
  CONSTRAINT cloud_deal_messages_id_deal_uq UNIQUE (id, cloud_deal_id)
);
CREATE INDEX IF NOT EXISTS cloud_deal_messages_thread_idx ON public.cloud_deal_messages (cloud_deal_id, channel_kind, thread_key, sent_at);
CREATE INDEX IF NOT EXISTS cloud_deal_messages_owner_idx ON public.cloud_deal_messages (owner_user_id);

CREATE TABLE IF NOT EXISTS public.cloud_blobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sha256             text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes         bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800),
  mime_type          text NULL,
  storage_path       text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  uploaded_at        timestamptz NULL,
  purge_requested_at timestamptz NULL,
  CONSTRAINT cloud_blobs_path_ck CHECK (storage_path = owner_user_id::text || '/' || id::text),
  CONSTRAINT cloud_blobs_id_owner_uq UNIQUE (id, owner_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_blobs_live_uq ON public.cloud_blobs (owner_user_id, sha256) WHERE purge_requested_at IS NULL;
CREATE INDEX IF NOT EXISTS cloud_blobs_fenced_idx ON public.cloud_blobs (purge_requested_at) WHERE purge_requested_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.cloud_deal_files (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id          uuid NOT NULL,
  cloud_deal_id          uuid NOT NULL,
  local_attachment_id    text NOT NULL CHECK (length(local_attachment_id) BETWEEN 1 AND 200),
  cloud_message_id       uuid NULL,
  blob_id                uuid NULL,
  filename               text NULL,
  mime_type              text NULL,
  size_bytes             bigint NULL,
  not_saved_reason       text NULL CHECK (not_saved_reason IN ('too_large', 'no_local_file', 'quota_exceeded')),
  content_hash           text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  version                bigint NOT NULL DEFAULT 1,
  origin                 text NOT NULL DEFAULT 'desktop' CHECK (origin IN ('desktop', 'cloud_user', 'ai_app')),
  source_updated_at      timestamptz NULL,
  last_change_request_id uuid NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  removed_at             timestamptz NULL,
  CONSTRAINT cloud_deal_files_live_name_ck CHECK (removed_at IS NOT NULL OR filename IS NOT NULL),
  CONSTRAINT cloud_deal_files_deal_fk FOREIGN KEY (cloud_deal_id, owner_user_id)
    REFERENCES public.cloud_deals(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT cloud_deal_files_message_fk FOREIGN KEY (cloud_message_id, cloud_deal_id)
    REFERENCES public.cloud_deal_messages(id, cloud_deal_id) ON DELETE SET NULL (cloud_message_id),
  CONSTRAINT cloud_deal_files_blob_fk FOREIGN KEY (blob_id, owner_user_id)
    REFERENCES public.cloud_blobs(id, owner_user_id) ON DELETE SET NULL (blob_id),
  CONSTRAINT cloud_deal_files_local_uq UNIQUE (cloud_deal_id, local_attachment_id)
);
CREATE INDEX IF NOT EXISTS cloud_deal_files_owner_idx ON public.cloud_deal_files (owner_user_id);
CREATE INDEX IF NOT EXISTS cloud_deal_files_blob_idx ON public.cloud_deal_files (blob_id);
CREATE INDEX IF NOT EXISTS cloud_deal_files_message_idx ON public.cloud_deal_files (cloud_message_id, cloud_deal_id);

-- ============================================================================ table grants and policies
ALTER TABLE public.cloud_autosave_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_addons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_deal_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_deal_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_deal_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_deal_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_deal_files ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.cloud_autosave_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.member_addons FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.cloud_deals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.cloud_deal_parties FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.cloud_deal_checklists FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.cloud_deal_checklist_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.cloud_deal_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.cloud_blobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.cloud_deal_files FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.cloud_autosave_settings TO authenticated;
GRANT SELECT ON TABLE public.member_addons TO authenticated;
GRANT SELECT ON TABLE public.cloud_deals TO authenticated;
GRANT SELECT ON TABLE public.cloud_deal_parties TO authenticated;
GRANT SELECT ON TABLE public.cloud_deal_checklists TO authenticated;
GRANT SELECT ON TABLE public.cloud_deal_checklist_items TO authenticated;
GRANT SELECT ON TABLE public.cloud_deal_messages TO authenticated;
GRANT SELECT ON TABLE public.cloud_blobs TO authenticated;
GRANT SELECT ON TABLE public.cloud_deal_files TO authenticated;

DROP POLICY IF EXISTS cloud_autosave_settings_select_own ON public.cloud_autosave_settings;
CREATE POLICY cloud_autosave_settings_select_own ON public.cloud_autosave_settings
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS member_addons_select_own ON public.member_addons;
CREATE POLICY member_addons_select_own ON public.member_addons
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS cloud_deals_select_own ON public.cloud_deals;
CREATE POLICY cloud_deals_select_own ON public.cloud_deals
  FOR SELECT TO authenticated USING (owner_user_id = (SELECT auth.uid()) /*POL:deals*/);
DROP POLICY IF EXISTS cloud_deal_parties_select_own ON public.cloud_deal_parties;
CREATE POLICY cloud_deal_parties_select_own ON public.cloud_deal_parties
  FOR SELECT TO authenticated USING (owner_user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS cloud_deal_checklists_select_own ON public.cloud_deal_checklists;
CREATE POLICY cloud_deal_checklists_select_own ON public.cloud_deal_checklists
  FOR SELECT TO authenticated USING (owner_user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS cloud_deal_checklist_items_select_own ON public.cloud_deal_checklist_items;
CREATE POLICY cloud_deal_checklist_items_select_own ON public.cloud_deal_checklist_items
  FOR SELECT TO authenticated USING (owner_user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS cloud_deal_messages_select_own ON public.cloud_deal_messages;
CREATE POLICY cloud_deal_messages_select_own ON public.cloud_deal_messages
  FOR SELECT TO authenticated USING (owner_user_id = (SELECT auth.uid()) /*POL:messages*/);
DROP POLICY IF EXISTS cloud_blobs_select_own ON public.cloud_blobs;
CREATE POLICY cloud_blobs_select_own ON public.cloud_blobs
  FOR SELECT TO authenticated USING (owner_user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS cloud_deal_files_select_own ON public.cloud_deal_files;
CREATE POLICY cloud_deal_files_select_own ON public.cloud_deal_files
  FOR SELECT TO authenticated USING (owner_user_id = (SELECT auth.uid()));

-- ============================================================================ bucket and storage policies
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('cloud-deal-files', 'cloud-deal-files', false, 52428800, NULL)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================ internal helpers
CREATE OR REPLACE FUNCTION public._cloud_autosave_current_notice_version() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = '' AS $f$ SELECT 1 $f$;
REVOKE ALL ON FUNCTION public._cloud_autosave_current_notice_version() FROM PUBLIC, anon, authenticated, service_role;

-- First field of r that is present and not valid for its type, or NULL.
CREATE OR REPLACE FUNCTION public._cloud_bad_field(r jsonb, p_ts text[], p_num text[], p_int text[], p_bool text[]) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $f$
  SELECT x.f FROM (
    SELECT k AS f, 1 AS o FROM unnest(p_ts) k
     WHERE r ? k AND jsonb_typeof(r -> k) <> 'null'
       AND (jsonb_typeof(r -> k) <> 'string' OR NOT pg_input_is_valid(r ->> k, 'timestamptz'))
    UNION ALL
    SELECT k, 2 FROM unnest(p_num) k
     WHERE r ? k AND jsonb_typeof(r -> k) <> 'null'
       AND (jsonb_typeof(r -> k) <> 'number' OR NOT pg_input_is_valid(r ->> k, 'double precision'))
    UNION ALL
    SELECT k, 3 FROM unnest(p_int) k
     WHERE r ? k AND jsonb_typeof(r -> k) <> 'null'
       AND (jsonb_typeof(r -> k) <> 'number' OR NOT pg_input_is_valid(r ->> k, 'integer'))
    UNION ALL
    SELECT k, 4 FROM unnest(p_bool) k
     WHERE r ? k AND jsonb_typeof(r -> k) NOT IN ('null', 'boolean')
  ) x ORDER BY x.o, x.f LIMIT 1
$f$;
REVOKE ALL ON FUNCTION public._cloud_bad_field(jsonb, text[], text[], text[], text[]) FROM PUBLIC, anon, authenticated, service_role;

-- applied | unchanged | conflict for a row that exists (p_version > 0) or a new row (p_version = 0).
CREATE OR REPLACE FUNCTION public._cloud_row_status(p_version bigint, p_removed_at timestamptz,
  p_cur_hash text, p_new_hash text, p_base bigint) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $f$
  SELECT CASE
    WHEN p_version > 0 AND p_removed_at IS NULL AND p_cur_hash = p_new_hash THEN 'unchanged'      /*ROW:same*/
    WHEN p_version > 0 AND p_removed_at IS NULL AND p_base IS NOT NULL
         AND p_base IS DISTINCT FROM p_version THEN 'conflict'                                    /*ROW:cas*/
    ELSE 'applied' END
$f$;
REVOKE ALL ON FUNCTION public._cloud_row_status(bigint, timestamptz, text, text, bigint) FROM PUBLIC, anon, authenticated, service_role;

-- Fences the owner's blobs among p_blob_ids that no file row references. Locks them first (id order),
-- then checks references in a later statement.
CREATE OR REPLACE FUNCTION public._cloud_fence_unreferenced(p_owner uuid, p_blob_ids uuid[]) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE n integer;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_owner AND auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_owner IS NULL OR p_blob_ids IS NULL OR cardinality(p_blob_ids) = 0 THEN RETURN 0; END IF;
  PERFORM 1 FROM public.cloud_blobs b
   WHERE b.id = ANY (p_blob_ids) AND b.owner_user_id = p_owner AND b.purge_requested_at IS NULL
   ORDER BY b.id FOR UPDATE;
  UPDATE public.cloud_blobs b SET purge_requested_at = now()
   WHERE b.id = ANY (p_blob_ids) AND b.owner_user_id = p_owner AND b.purge_requested_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_files f WHERE f.blob_id = b.id);       /*FENCE:unreferenced*/
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;
REVOKE ALL ON FUNCTION public._cloud_fence_unreferenced(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================ licence and state
-- Single place that reads plans and assignments. RETURNS TABLE is a replacement point (BACKLOG-4234).
-- org_billing_service_off answers for callers who can see the organization; every caller here is the
-- user themself (a member of that organization) or the service role.
CREATE OR REPLACE FUNCTION public._cloud_autosave_license(p_user_id uuid)
RETURNS TABLE (licensed boolean, path text, organization_id uuid, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $f$
#variable_conflict use_column
DECLARE v_org uuid; v_any boolean; v_reason text;
BEGIN
  -- auth.role() IS NULL: a session with no request claims (the database owner, e.g. a migration or a
  -- scheduled job). EXECUTE is revoked from every API role.
  IF (p_user_id = auth.uid() OR auth.role() = 'service_role' OR auth.role() IS NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  SELECT a.organization_id INTO v_org
    FROM public.member_addons a
    JOIN public.organization_members m
      ON m.id = a.membership_id AND m.organization_id = a.organization_id AND m.user_id = a.user_id  /*BRK:join*/
    JOIN public.organizations o ON o.id = a.organization_id
   WHERE a.user_id = p_user_id AND a.addon_key = 'cloud_autosave'
     AND a.revoked_at IS NULL                                                      /*BRK:revoked*/
     AND (a.ends_at IS NULL OR a.ends_at > now())                                  /*BRK:ends*/
     AND public.member_status_grants_access(m.license_status)                      /*BRK:member*/
     AND o.personal_owner_user_id IS NULL                                          /*BRK:notpersonal*/
     AND public.org_billing_service_off(o.id) IS FALSE                             /*BRK:billing*/
     AND public._org_feature_allowed(o.id, 'cloud_autosave_assignable') IS TRUE   /*BRK:plan*/
   ORDER BY a.assigned_at, a.organization_id                                       /*BRK:order*/
   LIMIT 1;
  IF v_org IS NOT NULL THEN
    RETURN QUERY SELECT true, 'brokerage'::text, v_org, NULL::text;
    RETURN;
  END IF;
  SELECT o.id INTO v_org
    FROM public.organizations o
    JOIN public.organization_members m ON m.organization_id = o.id AND m.user_id = p_user_id      /*SOLO:member*/
   WHERE o.personal_owner_user_id = p_user_id
     AND public.member_status_grants_access(m.license_status)                      /*SOLO:active*/
     AND public.org_billing_service_off(o.id) IS FALSE                             /*SOLO:billing*/
     AND public._org_feature_allowed(o.id, 'cloud_autosave') IS TRUE               /*SOLO:plan*/
   LIMIT 1;
  IF v_org IS NOT NULL THEN
    RETURN QUERY SELECT true, 'solo'::text, v_org, NULL::text;
    RETURN;
  END IF;
  SELECT true INTO v_any FROM public.member_addons a
   WHERE a.user_id = p_user_id AND a.addon_key = 'cloud_autosave' LIMIT 1;
  IF v_any IS TRUE THEN
    SELECT CASE
      WHEN count(*) FILTER (WHERE x.live) = 0 THEN 'assignment_lapsed'
      WHEN bool_and(NOT x.member_ok) FILTER (WHERE x.live) THEN 'member_inactive'
      WHEN bool_and(x.billing_off) FILTER (WHERE x.live) THEN 'billing_off'
      ELSE 'plan_disallows' END
      INTO v_reason
      FROM (SELECT (a.revoked_at IS NULL AND (a.ends_at IS NULL OR a.ends_at > now())) AS live,      /*REASON:live*/
                   public.member_status_grants_access(m.license_status) AS member_ok,
                   public.org_billing_service_off(o.id) IS NOT FALSE AS billing_off
              FROM public.member_addons a
              JOIN public.organization_members m ON m.id = a.membership_id
              JOIN public.organizations o ON o.id = a.organization_id
             WHERE a.user_id = p_user_id AND a.addon_key = 'cloud_autosave') x;
  END IF;
  RETURN QUERY SELECT false, NULL::text, NULL::uuid, coalesce(v_reason, 'no_license');
END $f$;
REVOKE ALL ON FUNCTION public._cloud_autosave_license(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- STABLE, no lock, no write.
CREATE OR REPLACE FUNCTION public.cloud_autosave_entitled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $f$
  SELECT coalesce((
    SELECT l.licensed AND s.enabled                                                /*ENT:enabled*/
           AND s.notice_version = public._cloud_autosave_current_notice_version()  /*ENT:notice*/
      FROM public._cloud_autosave_license(auth.uid()) l
      JOIN public.cloud_autosave_settings s ON s.user_id = auth.uid()
     WHERE auth.uid() IS NOT NULL), false)
$f$;
REVOKE ALL ON FUNCTION public.cloud_autosave_entitled() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_autosave_entitled() TO authenticated;

-- State shape v1. STABLE, no lock, no write.
CREATE OR REPLACE FUNCTION public.get_my_cloud_autosave_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); l record; s record; v_cur integer := public._cloud_autosave_current_notice_version();
        v_entitled boolean; v_reason text; v_used bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  SELECT * INTO l FROM public._cloud_autosave_license(v_uid);
  SELECT * INTO s FROM public.cloud_autosave_settings x WHERE x.user_id = v_uid;
  v_entitled := coalesce(l.licensed AND s.enabled AND s.notice_version = v_cur, false);
  v_reason := CASE
    WHEN v_entitled THEN NULL
    WHEN l.licensed IS NOT TRUE THEN coalesce(l.reason, 'no_license')
    WHEN s.enabled IS NOT TRUE THEN 'not_enabled'
    ELSE 'notice_outdated' END;
  SELECT coalesce(sum(b.size_bytes), 0) INTO v_used FROM public.cloud_blobs b
   WHERE b.owner_user_id = v_uid AND b.uploaded_at IS NOT NULL AND b.purge_requested_at IS NULL;
  RETURN jsonb_build_object(
    'schema_version', 1,
    'user_id', v_uid,
    'licensed', coalesce(l.licensed, false),
    'entitled', v_entitled,
    'path', l.path,
    'organization_id', l.organization_id,
    'reason', v_reason,
    'settings', jsonb_build_object('enabled', coalesce(s.enabled, false), 'notice_version', s.notice_version, 'accepted_at', s.accepted_at),
    'current_notice_version', v_cur,
    'storage', jsonb_build_object('used_bytes', v_used, 'quota_bytes', NULL));
END $f$;
REVOKE ALL ON FUNCTION public.get_my_cloud_autosave_state() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_cloud_autosave_state() TO authenticated;

-- ============================================================================ on / off and installs
DROP FUNCTION IF EXISTS public.set_my_cloud_autosave(boolean, integer);
CREATE OR REPLACE FUNCTION public.set_my_cloud_autosave(p_expected_user_id uuid, p_enabled boolean, p_notice_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); v_cur integer := public._cloud_autosave_current_notice_version();
        v_d jsonb; v_fenced integer; v_ai integer;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authorized'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('success', false, 'error', 'wrong_account'); END IF;   /*WHO:set*/
  IF p_enabled IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_input'); END IF;
  -- Default settings row (enabled = false), locked FOR UPDATE below; a refused call can leave it in place.
  INSERT INTO public.cloud_autosave_settings (user_id) VALUES (v_uid) ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR UPDATE;
  IF p_enabled THEN
    IF (SELECT l.licensed FROM public._cloud_autosave_license(v_uid) l) IS NOT TRUE THEN      /*SET:licence*/
      RETURN jsonb_build_object('success', false, 'error', 'not_licensed');
    END IF;
    IF p_notice_version IS DISTINCT FROM v_cur THEN                                          /*SET:notice*/
      RETURN jsonb_build_object('success', false, 'error', 'notice_outdated');
    END IF;
    UPDATE public.cloud_autosave_settings
       SET enabled = true, notice_version = p_notice_version, accepted_at = now(), enabled_at = now(), updated_at = now()
     WHERE user_id = v_uid;
    RETURN jsonb_build_object('success', true, 'enabled', true);
  END IF;
  -- Off: one unit. Any error undoes all of it and the call is refused.
  BEGIN
    UPDATE public.cloud_autosave_settings SET enabled = false, disabled_at = now(), updated_at = now() WHERE user_id = v_uid;
    SELECT jsonb_build_object(
      'deals', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = v_uid),
      'parties', (SELECT count(*) FROM public.cloud_deal_parties WHERE owner_user_id = v_uid),
      'checklists', (SELECT count(*) FROM public.cloud_deal_checklists WHERE owner_user_id = v_uid),
      'checklist_items', (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE owner_user_id = v_uid),
      'messages', (SELECT count(*) FROM public.cloud_deal_messages WHERE owner_user_id = v_uid),
      'files', (SELECT count(*) FROM public.cloud_deal_files WHERE owner_user_id = v_uid)) INTO v_d;
    DELETE FROM public.cloud_deals WHERE owner_user_id = v_uid;                                  /*SET:delete*/
    UPDATE public.cloud_blobs SET purge_requested_at = now()
     WHERE owner_user_id = v_uid AND purge_requested_at IS NULL;                                 /*SET:fence*/
    GET DIAGNOSTICS v_fenced = ROW_COUNT;
    IF to_regprocedure('public._mcp_disconnect_all_for(uuid,text)') IS NOT NULL THEN            /*SET:mcp*/
      v_ai := public._mcp_disconnect_all_for(v_uid, 'cloud_off');
    END IF;
  EXCEPTION WHEN OTHERS THEN                                                                     /*SET:unit*/
    RETURN jsonb_build_object('success', false, 'error', 'turn_off_failed');
  END;
  RETURN jsonb_build_object('success', true, 'enabled', false, 'deleted', v_d, 'blobs_fenced', v_fenced,
                            'ai_apps_disconnected', v_ai);
END $f$;
REVOKE ALL ON FUNCTION public.set_my_cloud_autosave(uuid, boolean, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_my_cloud_autosave(uuid, boolean, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.cloud_list_installs() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object('installs', coalesce((
    SELECT jsonb_agg(jsonb_build_object('source_install_id', x.source_install_id, 'deals', x.n,
                                        'last_synced_at', x.last_synced_at) ORDER BY x.last_synced_at DESC, x.source_install_id)
      FROM (SELECT d.source_install_id, count(*) AS n, max(d.last_synced_at) AS last_synced_at
              FROM public.cloud_deals d WHERE d.owner_user_id = v_uid                         /*OWNER:list_installs*/
             GROUP BY d.source_install_id) x), '[]'::jsonb));
END $f$;
REVOKE ALL ON FUNCTION public.cloud_list_installs() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_list_installs() TO authenticated;

-- Deletes one install's deals. Owner only, no entitlement. A blob is fenced only when no file row
-- (of any install) still references it.
DROP FUNCTION IF EXISTS public.cloud_delete_install(uuid);
CREATE OR REPLACE FUNCTION public.cloud_delete_install(p_expected_user_id uuid, p_source_install_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); v_blobs uuid[]; v_n integer; v_fenced integer;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authorized'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('success', false, 'error', 'wrong_account'); END IF;   /*WHO:delete_install*/
  IF p_source_install_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_input'); END IF;
  -- Default settings row (enabled = false), locked FOR UPDATE below; a refused call can leave it in place.
  INSERT INTO public.cloud_autosave_settings (user_id) VALUES (v_uid) ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR UPDATE;
  BEGIN
    SELECT array_agg(DISTINCT f.blob_id) INTO v_blobs
      FROM public.cloud_deal_files f JOIN public.cloud_deals d ON d.id = f.cloud_deal_id
     WHERE d.owner_user_id = v_uid AND d.source_install_id = p_source_install_id AND f.blob_id IS NOT NULL;
    DELETE FROM public.cloud_deals d
     WHERE d.owner_user_id = v_uid                                                  /*OWNER:delete_install*/
       AND d.source_install_id = p_source_install_id;                               /*INSTALL:delete_install*/
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_fenced := public._cloud_fence_unreferenced(v_uid, v_blobs);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'delete_failed');
  END;
  RETURN jsonb_build_object('success', true, 'deleted_deals', v_n, 'blobs_fenced', v_fenced);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_delete_install(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_delete_install(uuid, uuid) TO authenticated;

-- ============================================================================ assignment (service role)
CREATE OR REPLACE FUNCTION public.assign_member_addon(p_organization_id uuid, p_user_id uuid, p_addon_key text,
  p_assign boolean, p_ends_at timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_personal boolean; v_mid uuid; v_row record;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN                                      /*ASSIGN:role*/
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF p_addon_key IS DISTINCT FROM 'cloud_autosave' THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_addon'); END IF;
  IF p_assign IS NULL OR p_organization_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_input');
  END IF;
  SELECT o.personal_owner_user_id IS NOT NULL INTO v_personal
    FROM public.organizations o WHERE o.id = p_organization_id FOR NO KEY UPDATE;
  IF v_personal IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_member'); END IF;
  IF v_personal THEN RETURN jsonb_build_object('success', false, 'error', 'personal_org'); END IF;
  IF p_assign THEN
    SELECT m.id INTO v_mid FROM public.organization_members m
     WHERE m.organization_id = p_organization_id AND m.user_id = p_user_id
       AND public.member_status_grants_access(m.license_status);                            /*ASSIGN:member*/
    IF v_mid IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_member'); END IF;
    IF public._org_feature_allowed(p_organization_id, 'cloud_autosave_assignable') IS NOT TRUE THEN   /*ASSIGN:plan*/
      RETURN jsonb_build_object('success', false, 'error', 'plan_disallows');
    END IF;
    SELECT * INTO v_row FROM public.member_addons a
     WHERE a.membership_id = v_mid AND a.addon_key = p_addon_key AND a.revoked_at IS NULL FOR UPDATE;
    IF v_row.id IS NOT NULL THEN
      IF v_row.ends_at IS NOT DISTINCT FROM p_ends_at THEN
        RETURN jsonb_build_object('success', true, 'assignment_id', v_row.id, 'state', 'unchanged');
      END IF;
      UPDATE public.member_addons SET ends_at = p_ends_at WHERE id = v_row.id;
      RETURN jsonb_build_object('success', true, 'assignment_id', v_row.id, 'state', 'assigned');
    END IF;
    INSERT INTO public.member_addons (membership_id, organization_id, user_id, addon_key, source, ends_at)
    VALUES (v_mid, p_organization_id, p_user_id, p_addon_key, 'staff', p_ends_at) RETURNING * INTO v_row;
    RETURN jsonb_build_object('success', true, 'assignment_id', v_row.id, 'state', 'assigned');
  END IF;
  UPDATE public.member_addons a SET revoked_at = now()
   WHERE a.organization_id = p_organization_id AND a.user_id = p_user_id
     AND a.addon_key = p_addon_key AND a.revoked_at IS NULL
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('success', true, 'assignment_id', v_row.id,
                            'state', CASE WHEN v_row.id IS NULL THEN 'unchanged' ELSE 'revoked' END);
END $f$;
REVOKE ALL ON FUNCTION public.assign_member_addon(uuid, uuid, text, boolean, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assign_member_addon(uuid, uuid, text, boolean, timestamptz) TO service_role;

-- ============================================================================ deal upsert
DROP FUNCTION IF EXISTS public.cloud_upsert_deal(jsonb);
CREATE OR REPLACE FUNCTION public.cloud_upsert_deal(p_expected_user_id uuid, p_deal jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); v_local text; v_hash text; v_base bigint; v_inst uuid; v_org uuid;
        d record; v_status text; v_det text; v_st text; v_bad text; v_now timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:deal*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:deal*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  IF jsonb_typeof(p_deal) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_input', 'detail', jsonb_build_object('index', 0));
  END IF;
  IF octet_length(p_deal::text) > 1048576 THEN                                               /*CAP:bytes:deal*/
    RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large');
  END IF;
  v_local := p_deal ->> 'local_id'; v_hash := p_deal ->> 'content_hash';
  v_bad := CASE
    WHEN jsonb_typeof(p_deal -> 'source_install_id') IS DISTINCT FROM 'string'
         OR NOT pg_input_is_valid(p_deal ->> 'source_install_id', 'uuid') THEN 'source_install_id'
    WHEN jsonb_typeof(p_deal -> 'local_id') IS DISTINCT FROM 'string'
         OR (length(v_local) BETWEEN 1 AND 200) IS NOT TRUE THEN 'local_id'
    WHEN (v_hash ~ '^[0-9a-f]{64}$') IS NOT TRUE THEN 'content_hash'
    WHEN p_deal ? 'base_version' AND jsonb_typeof(p_deal -> 'base_version') <> 'null'
         AND (jsonb_typeof(p_deal -> 'base_version') <> 'number' OR NOT pg_input_is_valid(p_deal ->> 'base_version', 'bigint')) THEN 'base_version'
    WHEN p_deal ? 'organization_id' AND jsonb_typeof(p_deal -> 'organization_id') <> 'null'
         AND (jsonb_typeof(p_deal -> 'organization_id') <> 'string' OR NOT pg_input_is_valid(p_deal ->> 'organization_id', 'uuid')) THEN 'organization_id'
    WHEN p_deal ? 'details' AND jsonb_typeof(p_deal -> 'details') NOT IN ('null', 'object') THEN 'details'
    ELSE public._cloud_bad_field(p_deal,
           ARRAY['started_at', 'closed_at', 'reviewed_at', 'local_created_at', 'source_updated_at'],
           ARRAY['detection_confidence'], ARRAY['texts_outside_window_count'], ARRAY[]::text[]) END;   /*DEAL:values*/
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_input', 'detail', jsonb_build_object('index', 0, 'field', v_bad));
  END IF;
  v_inst := (p_deal ->> 'source_install_id')::uuid;
  v_base := (p_deal ->> 'base_version')::bigint;
  IF p_deal ->> 'organization_id' IS NOT NULL THEN
    SELECT o.id INTO v_org FROM public.organizations o
      JOIN public.organization_members m ON m.organization_id = o.id AND m.user_id = v_uid
     WHERE o.id = (p_deal ->> 'organization_id')::uuid
       AND o.personal_owner_user_id IS NULL                                                  /*ORG:notpersonal*/
       AND public.member_status_grants_access(m.license_status);                             /*ORG:member*/
    IF v_org IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_organization'); END IF;
  END IF;
  v_det := p_deal ->> 'detection_status'; v_st := p_deal ->> 'status';
  INSERT INTO public.cloud_deals (owner_user_id, source_install_id, local_transaction_id, content_hash, version)
  VALUES (v_uid, v_inst, v_local, v_hash, 0)
  ON CONFLICT (owner_user_id, source_install_id, local_transaction_id) DO NOTHING;
  SELECT * INTO d FROM public.cloud_deals x
   WHERE x.owner_user_id = v_uid AND x.source_install_id = v_inst AND x.local_transaction_id = v_local FOR UPDATE;
  v_status := public._cloud_row_status(d.version, NULL, d.content_hash, v_hash, v_base);
  IF v_status = 'applied' THEN
    v_now := clock_timestamp();                                                              /*CLOCK:deal*/
    UPDATE public.cloud_deals SET
      organization_id = v_org,
      property_address = p_deal ->> 'property_address', property_street = p_deal ->> 'property_street',
      property_city = p_deal ->> 'property_city', property_state = p_deal ->> 'property_state',
      property_zip = p_deal ->> 'property_zip', transaction_type = p_deal ->> 'transaction_type',
      status = v_st, started_at = (p_deal ->> 'started_at')::timestamptz, closed_at = (p_deal ->> 'closed_at')::timestamptz,
      detection_status = v_det, detection_source = p_deal ->> 'detection_source',
      detection_confidence = (p_deal ->> 'detection_confidence')::double precision,
      detection_method = p_deal ->> 'detection_method', reviewed_at = (p_deal ->> 'reviewed_at')::timestamptz,
      local_created_at = (p_deal ->> 'local_created_at')::timestamptz, lock_reason = p_deal ->> 'lock_reason',
      texts_outside_window_count = (p_deal ->> 'texts_outside_window_count')::integer,
      details = CASE WHEN jsonb_typeof(p_deal -> 'details') = 'object' THEN p_deal -> 'details' ELSE '{}'::jsonb END,
      -- electron/services/db/transactionOpenSql.ts:66-67
      is_confirmed = (v_st IS NULL OR v_st <> 'rejected')
                     AND (v_det IS NULL OR v_det NOT IN ('pending', 'rejected')),               /*DEAL:confirmed*/
      source_updated_at = (p_deal ->> 'source_updated_at')::timestamptz,
      content_hash = v_hash, version = d.version + 1, updated_at = now(), last_synced_at = greatest(last_synced_at, v_now)
     WHERE id = d.id RETURNING * INTO d;
  END IF;
  RETURN jsonb_build_object('ok', true, 'results', jsonb_build_array(jsonb_build_object(
    'local_id', v_local, 'cloud_id', d.id, 'version', d.version, 'content_hash', d.content_hash, 'status', v_status)));
END $f$;
REVOKE ALL ON FUNCTION public.cloud_upsert_deal(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_upsert_deal(uuid, jsonb) TO authenticated;

-- ============================================================================ child upserts
-- Shared rules: settings FOR SHARE, entitlement, the deal must be the caller's and this install's
-- (else not_found), at most 500 rows and 16 MB per batch, structural errors refuse the batch,
-- value errors reject the row.

DROP FUNCTION IF EXISTS public.cloud_upsert_parties(uuid, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.cloud_upsert_parties(p_expected_user_id uuid, p_source_install_id uuid, p_cloud_deal_id uuid, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); v_deal uuid; r jsonb; i integer := 0; out jsonb := '[]'::jsonb;
        cur record; v_status text; v_bad text; v_withheld boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:parties*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:parties*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  SELECT d.id INTO v_deal FROM public.cloud_deals d
   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:parties*/
     AND d.source_install_id = p_source_install_id                                           /*INSTALL:parties*/
   FOR NO KEY UPDATE;
  IF v_deal IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  IF jsonb_array_length(p_rows) > 500 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:rows:parties*/
  IF octet_length(p_rows::text) > 16777216 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:bytes:parties*/
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object'
       OR jsonb_typeof(r -> 'local_id') IS DISTINCT FROM 'string' OR (length(r ->> 'local_id') BETWEEN 1 AND 200) IS NOT TRUE
       OR ((r ->> 'content_hash') ~ '^[0-9a-f]{64}$') IS NOT TRUE
       OR (r ? 'base_version' AND jsonb_typeof(r -> 'base_version') <> 'null'
           AND (jsonb_typeof(r -> 'base_version') <> 'number' OR NOT pg_input_is_valid(r ->> 'base_version', 'bigint'))) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_input', 'detail', jsonb_build_object('index', i));
    END IF;
    i := i + 1;
  END LOOP;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_bad := public._cloud_bad_field(r, ARRAY['source_updated_at'], ARRAY[]::text[], ARRAY[]::text[], ARRAY['is_primary', 'contact_deleted', 'details_withheld']);
    IF v_bad IS NULL AND jsonb_typeof(r -> 'emails') NOT IN ('null', 'array') THEN v_bad := 'emails'; END IF;
    IF v_bad IS NULL AND jsonb_typeof(r -> 'phones') NOT IN ('null', 'array') THEN v_bad := 'phones'; END IF;
    IF v_bad IS NOT NULL THEN
      out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'invalid_value', 'field', v_bad);
      CONTINUE;
    END IF;
    v_withheld := coalesce((r ->> 'details_withheld')::boolean, false);                         /*PTY:withheld*/
    INSERT INTO public.cloud_deal_parties (owner_user_id, cloud_deal_id, local_party_id, content_hash, version)
    VALUES (v_uid, v_deal, r ->> 'local_id', r ->> 'content_hash', 0)
    ON CONFLICT (cloud_deal_id, local_party_id) DO NOTHING;
    SELECT * INTO cur FROM public.cloud_deal_parties WHERE cloud_deal_id = v_deal AND local_party_id = r ->> 'local_id' FOR UPDATE;
    v_status := public._cloud_row_status(cur.version, cur.removed_at, cur.content_hash, r ->> 'content_hash', (r ->> 'base_version')::bigint);
    IF v_status = 'applied' THEN
      UPDATE public.cloud_deal_parties SET
        local_contact_id = r ->> 'local_contact_id', role = r ->> 'role', role_category = r ->> 'role_category',
        specific_role = r ->> 'specific_role', is_primary = (r ->> 'is_primary')::boolean, notes = r ->> 'notes',
        -- a withheld person is stored with name, company, emails and phones NULL, whatever the row sent
        display_name = CASE WHEN v_withheld THEN NULL ELSE r ->> 'display_name' END,                           /*PTY:name*/
        company = CASE WHEN v_withheld THEN NULL ELSE r ->> 'company' END,                                     /*PTY:company*/
        emails = CASE WHEN v_withheld THEN NULL WHEN jsonb_typeof(r -> 'emails') = 'array' THEN r -> 'emails' END,   /*PTY:emails*/
        phones = CASE WHEN v_withheld THEN NULL WHEN jsonb_typeof(r -> 'phones') = 'array' THEN r -> 'phones' END,   /*PTY:phones*/
        details_withheld = v_withheld,
        contact_source = r ->> 'contact_source', contact_deleted = coalesce((r ->> 'contact_deleted')::boolean, false),
        removed_reason = r ->> 'removed_reason', source_updated_at = (r ->> 'source_updated_at')::timestamptz,
        content_hash = r ->> 'content_hash', version = cur.version + 1, updated_at = now(), removed_at = NULL
       WHERE id = cur.id RETURNING * INTO cur;
    END IF;
    out := out || jsonb_build_object('local_id', r ->> 'local_id', 'cloud_id', cur.id, 'version', cur.version,
                                     'content_hash', cur.content_hash, 'status', v_status);
  END LOOP;
  UPDATE public.cloud_deals SET last_synced_at = greatest(last_synced_at, clock_timestamp()) WHERE id = v_deal;   /*CLOCK:parties*/
  RETURN jsonb_build_object('ok', true, 'results', out);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_upsert_parties(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_upsert_parties(uuid, uuid, uuid, jsonb) TO authenticated;

DROP FUNCTION IF EXISTS public.cloud_upsert_checklists(uuid, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.cloud_upsert_checklists(p_expected_user_id uuid, p_source_install_id uuid, p_cloud_deal_id uuid, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); v_deal uuid; r jsonb; i integer := 0; out jsonb := '[]'::jsonb;
        cur record; v_status text; v_bad text; v_private boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:checklists*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:checklists*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  SELECT d.id INTO v_deal FROM public.cloud_deals d
   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:checklists*/
     AND d.source_install_id = p_source_install_id                                           /*INSTALL:checklists*/
   FOR NO KEY UPDATE;
  IF v_deal IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  IF jsonb_array_length(p_rows) > 500 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:rows:checklists*/
  IF octet_length(p_rows::text) > 16777216 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:bytes:checklists*/
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object'
       OR jsonb_typeof(r -> 'local_id') IS DISTINCT FROM 'string' OR (length(r ->> 'local_id') BETWEEN 1 AND 200) IS NOT TRUE
       OR ((r ->> 'content_hash') ~ '^[0-9a-f]{64}$') IS NOT TRUE
       OR jsonb_typeof(r -> 'template_id') IS DISTINCT FROM 'string'
       OR (r ? 'base_version' AND jsonb_typeof(r -> 'base_version') <> 'null'
           AND (jsonb_typeof(r -> 'base_version') <> 'number' OR NOT pg_input_is_valid(r ->> 'base_version', 'bigint'))) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_input', 'detail', jsonb_build_object('index', i));
    END IF;
    i := i + 1;
  END LOOP;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_bad := public._cloud_bad_field(r, ARRAY['selected_at', 'source_updated_at'], ARRAY[]::text[], ARRAY['sort_order'], ARRAY['is_private']);
    IF v_bad IS NOT NULL THEN
      out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'invalid_value', 'field', v_bad);
      CONTINUE;
    END IF;
    v_private := (r ->> 'template_id') = 'keepr:my-items' OR coalesce((r ->> 'is_private')::boolean, false);   /*CHK:private*/
    INSERT INTO public.cloud_deal_checklists (owner_user_id, cloud_deal_id, local_checklist_id, template_id, content_hash, version)
    VALUES (v_uid, v_deal, r ->> 'local_id', r ->> 'template_id', r ->> 'content_hash', 0)
    ON CONFLICT (cloud_deal_id, local_checklist_id) DO NOTHING;
    SELECT * INTO cur FROM public.cloud_deal_checklists WHERE cloud_deal_id = v_deal AND local_checklist_id = r ->> 'local_id' FOR UPDATE;
    v_status := public._cloud_row_status(cur.version, cur.removed_at, cur.content_hash, r ->> 'content_hash', (r ->> 'base_version')::bigint);
    IF v_status = 'applied' THEN
      UPDATE public.cloud_deal_checklists SET
        template_id = r ->> 'template_id', template_name = r ->> 'template_name',
        sort_order = (r ->> 'sort_order')::integer, selected_at = (r ->> 'selected_at')::timestamptz,
        is_private = v_private, source_updated_at = (r ->> 'source_updated_at')::timestamptz,
        content_hash = r ->> 'content_hash', version = cur.version + 1, updated_at = now(), removed_at = NULL
       WHERE id = cur.id RETURNING * INTO cur;
      UPDATE public.cloud_deal_checklist_items SET is_private = v_private
       WHERE cloud_checklist_id = cur.id AND cloud_deal_id = v_deal AND is_private IS DISTINCT FROM v_private;   /*CHK:propagate*/
    END IF;
    out := out || jsonb_build_object('local_id', r ->> 'local_id', 'cloud_id', cur.id, 'version', cur.version,
                                     'content_hash', cur.content_hash, 'status', v_status);
  END LOOP;
  UPDATE public.cloud_deals SET last_synced_at = greatest(last_synced_at, clock_timestamp()) WHERE id = v_deal;   /*CLOCK:checklists*/
  RETURN jsonb_build_object('ok', true, 'results', out);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_upsert_checklists(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_upsert_checklists(uuid, uuid, uuid, jsonb) TO authenticated;

DROP FUNCTION IF EXISTS public.cloud_upsert_checklist_items(uuid, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.cloud_upsert_checklist_items(p_expected_user_id uuid, p_source_install_id uuid, p_cloud_deal_id uuid, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); v_deal uuid; r jsonb; i integer := 0; out jsonb := '[]'::jsonb;
        cur record; v_status text; v_bad text; p record;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:items*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:items*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  SELECT d.id INTO v_deal FROM public.cloud_deals d
   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:items*/
     AND d.source_install_id = p_source_install_id                                           /*INSTALL:items*/
   FOR NO KEY UPDATE;
  IF v_deal IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  IF jsonb_array_length(p_rows) > 500 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:rows:items*/
  IF octet_length(p_rows::text) > 16777216 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:bytes:items*/
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object'
       OR jsonb_typeof(r -> 'local_id') IS DISTINCT FROM 'string' OR (length(r ->> 'local_id') BETWEEN 1 AND 200) IS NOT TRUE
       OR ((r ->> 'content_hash') ~ '^[0-9a-f]{64}$') IS NOT TRUE
       OR jsonb_typeof(r -> 'local_checklist_id') IS DISTINCT FROM 'string'
       OR (r ? 'base_version' AND jsonb_typeof(r -> 'base_version') <> 'null'
           AND (jsonb_typeof(r -> 'base_version') <> 'number' OR NOT pg_input_is_valid(r ->> 'base_version', 'bigint'))) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_input', 'detail', jsonb_build_object('index', i));
    END IF;
    i := i + 1;
  END LOOP;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_bad := public._cloud_bad_field(r, ARRAY['checked_at', 'local_created_at', 'source_updated_at'], ARRAY[]::text[],
                                     ARRAY['sort_order'], ARRAY['is_required', 'is_checked']);
    IF v_bad IS NULL AND jsonb_typeof(r -> 'links') NOT IN ('null', 'array') THEN v_bad := 'links'; END IF;
    IF v_bad IS NOT NULL THEN
      out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'invalid_value', 'field', v_bad);
      CONTINUE;
    END IF;
    SELECT c.id, c.is_private INTO p FROM public.cloud_deal_checklists c
     WHERE c.cloud_deal_id = v_deal AND c.local_checklist_id = r ->> 'local_checklist_id' AND c.removed_at IS NULL;   /*ITEM:parent*/
    IF p.id IS NULL THEN
      out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'parent_missing');
      CONTINUE;
    END IF;
    INSERT INTO public.cloud_deal_checklist_items (owner_user_id, cloud_deal_id, cloud_checklist_id, local_item_id, content_hash, version)
    VALUES (v_uid, v_deal, p.id, r ->> 'local_id', r ->> 'content_hash', 0)
    ON CONFLICT (cloud_deal_id, local_item_id) DO NOTHING;
    SELECT * INTO cur FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = v_deal AND local_item_id = r ->> 'local_id' FOR UPDATE;
    v_status := public._cloud_row_status(cur.version, cur.removed_at, cur.content_hash, r ->> 'content_hash', (r ->> 'base_version')::bigint);
    IF v_status = 'applied' THEN
      UPDATE public.cloud_deal_checklist_items SET
        cloud_checklist_id = p.id, title = r ->> 'title', description = r ->> 'description',
        is_required = (r ->> 'is_required')::boolean, expected_document_type = r ->> 'expected_document_type',
        is_checked = (r ->> 'is_checked')::boolean, checked_at = (r ->> 'checked_at')::timestamptz, note = r ->> 'note',
        sort_order = (r ->> 'sort_order')::integer, local_created_at = (r ->> 'local_created_at')::timestamptz,
        links = CASE WHEN jsonb_typeof(r -> 'links') = 'array' THEN r -> 'links' END,
        is_private = p.is_private,                                                             /*ITEM:private*/
        source_updated_at = (r ->> 'source_updated_at')::timestamptz,
        content_hash = r ->> 'content_hash', version = cur.version + 1, updated_at = now(), removed_at = NULL
       WHERE id = cur.id RETURNING * INTO cur;
    END IF;
    out := out || jsonb_build_object('local_id', r ->> 'local_id', 'cloud_id', cur.id, 'version', cur.version,
                                     'content_hash', cur.content_hash, 'status', v_status);
  END LOOP;
  UPDATE public.cloud_deals SET last_synced_at = greatest(last_synced_at, clock_timestamp()) WHERE id = v_deal;   /*CLOCK:items*/
  RETURN jsonb_build_object('ok', true, 'results', out);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_upsert_checklist_items(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_upsert_checklist_items(uuid, uuid, uuid, jsonb) TO authenticated;

DROP FUNCTION IF EXISTS public.cloud_upsert_messages(uuid, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.cloud_upsert_messages(p_expected_user_id uuid, p_source_install_id uuid, p_cloud_deal_id uuid, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); v_deal uuid; r jsonb; i integer := 0; out jsonb := '[]'::jsonb;
        cur record; v_status text; v_body text; v_trunc boolean; v_kind text; v_state text; v_bad text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:messages*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:messages*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  SELECT d.id INTO v_deal FROM public.cloud_deals d
   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:messages*/
     AND d.source_install_id = p_source_install_id                                           /*INSTALL:messages*/
   FOR NO KEY UPDATE;
  IF v_deal IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  IF jsonb_array_length(p_rows) > 500 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:rows:messages*/
  IF octet_length(p_rows::text) > 16777216 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:bytes:messages*/
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object'
       OR jsonb_typeof(r -> 'local_id') IS DISTINCT FROM 'string' OR (length(r ->> 'local_id') BETWEEN 1 AND 200) IS NOT TRUE
       OR ((r ->> 'content_hash') ~ '^[0-9a-f]{64}$') IS NOT TRUE
       OR (r ->> 'channel_kind') IN ('email', 'text') IS NOT TRUE
       OR jsonb_typeof(r -> 'hidden_from_export') IS DISTINCT FROM 'boolean'
       OR (r ? 'base_version' AND jsonb_typeof(r -> 'base_version') <> 'null'
           AND (jsonb_typeof(r -> 'base_version') <> 'number' OR NOT pg_input_is_valid(r ->> 'base_version', 'bigint'))) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_input', 'detail', jsonb_build_object('index', i));
    END IF;
    i := i + 1;
  END LOOP;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_kind := r ->> 'channel_kind';
    v_bad := public._cloud_bad_field(r, ARRAY['sent_at', 'received_at', 'linked_at', 'source_updated_at'],
                                     ARRAY['link_confidence'], ARRAY[]::text[], ARRAY[]::text[]);
    IF v_bad IS NULL AND r ->> 'channel' IS NOT NULL AND (r ->> 'channel') NOT IN ('email', 'sms', 'imessage') THEN v_bad := 'channel'; END IF;
    IF v_bad IS NULL AND coalesce(r ->> 'link_origin', 'link') NOT IN ('link', 'review_queue') THEN v_bad := 'link_origin'; END IF;
    IF v_bad IS NOT NULL THEN                                                                /*MSG:values*/
      out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'invalid_value', 'field', v_bad);
      CONTINUE;
    END IF;
    IF v_kind = 'text' AND r ->> 'thread_key' IS NULL THEN
      out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'thread_key_required');
      CONTINUE;
    END IF;
    v_body := r ->> 'body_text'; v_trunc := false;
    IF char_length(v_body) > 1000000 THEN v_body := left(v_body, 1000000); v_trunc := true; END IF;   /*MSG:truncate*/
    v_state := CASE WHEN coalesce(r ->> 'link_origin', 'link') = 'review_queue' THEN 'suggested'
                    WHEN r ->> 'match_reason' = 'address_missing' THEN 'needs_review'
                    ELSE 'linked' END;                                                            /*MSG:linkstate*/
    INSERT INTO public.cloud_deal_messages (owner_user_id, cloud_deal_id, channel_kind, local_message_id, thread_key, content_hash, version)
    VALUES (v_uid, v_deal, v_kind, r ->> 'local_id', r ->> 'thread_key', r ->> 'content_hash', 0)
    ON CONFLICT (cloud_deal_id, channel_kind, local_message_id) DO NOTHING;
    SELECT * INTO cur FROM public.cloud_deal_messages
     WHERE cloud_deal_id = v_deal AND channel_kind = v_kind AND local_message_id = r ->> 'local_id' FOR UPDATE;
    v_status := public._cloud_row_status(cur.version, cur.removed_at, cur.content_hash, r ->> 'content_hash', (r ->> 'base_version')::bigint);
    IF v_status = 'applied' THEN
      UPDATE public.cloud_deal_messages SET
        local_link_id = r ->> 'local_link_id', channel = r ->> 'channel', direction = r ->> 'direction',
        subject = r ->> 'subject', body_text = v_body, body_truncated = v_trunc,
        participants = CASE WHEN jsonb_typeof(r -> 'participants') = 'null' THEN NULL ELSE r -> 'participants' END,
        thread_key = r ->> 'thread_key',
        sent_at = (r ->> 'sent_at')::timestamptz, received_at = (r ->> 'received_at')::timestamptz,
        link_source = r ->> 'link_source', link_confidence = (r ->> 'link_confidence')::double precision,
        match_reason = r ->> 'match_reason', linked_at = (r ->> 'linked_at')::timestamptz,
        link_origin = coalesce(r ->> 'link_origin', 'link'), link_state = v_state,
        hidden_from_export = (r ->> 'hidden_from_export')::boolean,
        source_updated_at = (r ->> 'source_updated_at')::timestamptz,
        content_hash = r ->> 'content_hash', version = cur.version + 1, updated_at = now(), removed_at = NULL
       WHERE id = cur.id RETURNING * INTO cur;
    END IF;
    out := out || jsonb_build_object('local_id', r ->> 'local_id', 'cloud_id', cur.id, 'version', cur.version,
                                     'content_hash', cur.content_hash, 'status', v_status, 'body_truncated', cur.body_truncated);
  END LOOP;
  UPDATE public.cloud_deals SET last_synced_at = greatest(last_synced_at, clock_timestamp()) WHERE id = v_deal;   /*MSG:touch*/
  RETURN jsonb_build_object('ok', true, 'results', out);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_upsert_messages(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_upsert_messages(uuid, uuid, uuid, jsonb) TO authenticated;

DROP FUNCTION IF EXISTS public.cloud_upsert_files(uuid, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.cloud_upsert_files(p_expected_user_id uuid, p_source_install_id uuid, p_cloud_deal_id uuid, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); v_deal uuid; r jsonb; i integer := 0; out jsonb := '[]'::jsonb;
        cur record; v_status text; v_bad text; v_msg uuid; v_blob uuid; v_old_blob uuid; v_old_blobs uuid[] := '{}';
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:files*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:files*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  SELECT d.id INTO v_deal FROM public.cloud_deals d
   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:files*/
     AND d.source_install_id = p_source_install_id                                           /*INSTALL:files*/
   FOR NO KEY UPDATE;
  IF v_deal IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  IF jsonb_array_length(p_rows) > 500 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:rows:files*/
  IF octet_length(p_rows::text) > 16777216 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:bytes:files*/
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object'
       OR jsonb_typeof(r -> 'local_id') IS DISTINCT FROM 'string' OR (length(r ->> 'local_id') BETWEEN 1 AND 200) IS NOT TRUE
       OR ((r ->> 'content_hash') ~ '^[0-9a-f]{64}$') IS NOT TRUE
       OR (r ? 'base_version' AND jsonb_typeof(r -> 'base_version') <> 'null'
           AND (jsonb_typeof(r -> 'base_version') <> 'number' OR NOT pg_input_is_valid(r ->> 'base_version', 'bigint'))) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_input', 'detail', jsonb_build_object('index', i));
    END IF;
    i := i + 1;
  END LOOP;
  -- every blob this call can attach or replace, locked once, in id order
  PERFORM 1 FROM public.cloud_blobs b
   WHERE b.owner_user_id = v_uid
     AND ((b.purge_requested_at IS NULL AND b.sha256 IN (SELECT e ->> 'blob_sha256' FROM jsonb_array_elements(p_rows) e))
          OR b.id IN (SELECT f.blob_id FROM public.cloud_deal_files f
                       WHERE f.cloud_deal_id = v_deal
                         AND f.local_attachment_id IN (SELECT e ->> 'local_id' FROM jsonb_array_elements(p_rows) e)))
   ORDER BY b.id FOR UPDATE;                                                                 /*FILE:lockblobs*/
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_bad := public._cloud_bad_field(r, ARRAY['source_updated_at'], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[]);
    IF v_bad IS NULL AND (jsonb_typeof(r -> 'filename') IS DISTINCT FROM 'string' OR length(r ->> 'filename') = 0) THEN v_bad := 'filename'; END IF;
    IF v_bad IS NULL AND r ? 'size_bytes' AND jsonb_typeof(r -> 'size_bytes') <> 'null'
       AND (jsonb_typeof(r -> 'size_bytes') <> 'number' OR NOT pg_input_is_valid(r ->> 'size_bytes', 'bigint')) THEN v_bad := 'size_bytes'; END IF;
    IF v_bad IS NULL AND r ->> 'not_saved_reason' IS NOT NULL
       AND (r ->> 'not_saved_reason') NOT IN ('too_large', 'no_local_file', 'quota_exceeded') THEN v_bad := 'not_saved_reason'; END IF;
    IF v_bad IS NULL AND r ->> 'message_local_id' IS NOT NULL
       AND (r ->> 'message_channel_kind') IN ('email', 'text') IS NOT TRUE THEN v_bad := 'message_channel_kind'; END IF;
    IF v_bad IS NULL AND r ->> 'blob_sha256' IS NOT NULL AND ((r ->> 'blob_sha256') ~ '^[0-9a-f]{64}$') IS NOT TRUE THEN v_bad := 'blob_sha256'; END IF;
    IF v_bad IS NOT NULL THEN
      out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'invalid_value', 'field', v_bad);
      CONTINUE;
    END IF;
    v_msg := NULL; v_blob := NULL;
    IF r ->> 'message_local_id' IS NOT NULL THEN
      SELECT m.id INTO v_msg FROM public.cloud_deal_messages m
       WHERE m.cloud_deal_id = v_deal AND m.channel_kind = r ->> 'message_channel_kind'
         AND m.local_message_id = r ->> 'message_local_id'
         AND m.removed_at IS NULL;                                                            /*FILE:livemessage*/
      IF v_msg IS NULL THEN
        out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'parent_missing');
        CONTINUE;
      END IF;
    END IF;
    IF r ->> 'blob_sha256' IS NOT NULL THEN
      SELECT b.id INTO v_blob FROM public.cloud_blobs b
       WHERE b.owner_user_id = v_uid                                                          /*OWNER:fileblob*/
         AND b.sha256 = r ->> 'blob_sha256'
         AND b.uploaded_at IS NOT NULL                                                        /*FILE:uploaded*/
         AND b.purge_requested_at IS NULL;                                                    /*FILE:unfenced*/
      IF v_blob IS NULL THEN
        out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'blob_unavailable');
        CONTINUE;
      END IF;
    END IF;
    INSERT INTO public.cloud_deal_files (owner_user_id, cloud_deal_id, local_attachment_id, filename, content_hash, version)
    VALUES (v_uid, v_deal, r ->> 'local_id', r ->> 'filename', r ->> 'content_hash', 0)
    ON CONFLICT (cloud_deal_id, local_attachment_id) DO NOTHING;
    SELECT * INTO cur FROM public.cloud_deal_files WHERE cloud_deal_id = v_deal AND local_attachment_id = r ->> 'local_id' FOR UPDATE;
    v_status := public._cloud_row_status(cur.version, cur.removed_at, cur.content_hash, r ->> 'content_hash', (r ->> 'base_version')::bigint);
    IF v_status = 'applied' THEN
      v_old_blob := cur.blob_id;
      UPDATE public.cloud_deal_files SET
        cloud_message_id = v_msg, blob_id = v_blob, filename = r ->> 'filename', mime_type = r ->> 'mime_type',
        size_bytes = (r ->> 'size_bytes')::bigint, not_saved_reason = r ->> 'not_saved_reason',
        source_updated_at = (r ->> 'source_updated_at')::timestamptz,
        content_hash = r ->> 'content_hash', version = cur.version + 1, updated_at = now(), removed_at = NULL
       WHERE id = cur.id RETURNING * INTO cur;
      IF v_old_blob IS NOT NULL AND v_old_blob IS DISTINCT FROM v_blob THEN
        v_old_blobs := v_old_blobs || v_old_blob;
      END IF;
    END IF;
    out := out || jsonb_build_object('local_id', r ->> 'local_id', 'cloud_id', cur.id, 'version', cur.version,
                                     'content_hash', cur.content_hash, 'status', v_status);
  END LOOP;
  PERFORM public._cloud_fence_unreferenced(v_uid, v_old_blobs);                              /*FILE:fence*/
  UPDATE public.cloud_deals SET last_synced_at = greatest(last_synced_at, clock_timestamp()) WHERE id = v_deal;   /*CLOCK:files*/
  RETURN jsonb_build_object('ok', true, 'results', out);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_upsert_files(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_upsert_files(uuid, uuid, uuid, jsonb) TO authenticated;

-- ============================================================================ tombstone, delete, mark synced
-- Owner and install only; no entitlement. Locks the caller's own deals that hold the named rows
-- (id order) before the rows.
DROP FUNCTION IF EXISTS public.cloud_tombstone(uuid, text, uuid[]);
CREATE OR REPLACE FUNCTION public.cloud_tombstone(p_expected_user_id uuid, p_source_install_id uuid, p_kind text, p_cloud_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); v_tab text; v_id uuid; out jsonb := '[]'::jsonb;
        v_row_id uuid; v_row_deal uuid; v_row_removed timestamptz; v_row_version bigint; v_blob uuid; v_deals uuid[];
        v_fence uuid[] := '{}'; v_now timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authorized'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:tombstone*/
  v_tab := CASE p_kind WHEN 'party' THEN 'cloud_deal_parties' WHEN 'checklist' THEN 'cloud_deal_checklists'
                       WHEN 'checklist_item' THEN 'cloud_deal_checklist_items' WHEN 'message' THEN 'cloud_deal_messages'
                       WHEN 'file' THEN 'cloud_deal_files' END;
  IF v_tab IS NULL OR p_source_install_id IS NULL OR p_cloud_ids IS NULL OR cardinality(p_cloud_ids) > 1000 THEN   /*CAP:tombstone*/
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
  END IF;
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  EXECUTE format(
    'SELECT array_agg(x.id) FROM (SELECT d.id FROM public.cloud_deals d
       WHERE d.owner_user_id = $1 AND d.source_install_id = $2
         AND d.id IN (SELECT t.cloud_deal_id FROM public.%I t WHERE t.id = ANY ($3) AND t.owner_user_id = $1)
       ORDER BY d.id FOR NO KEY UPDATE) x', v_tab)
    INTO v_deals USING v_uid, p_source_install_id, p_cloud_ids;                              /*TOMB:lockdeals*/
  v_now := clock_timestamp();                                                                /*CLOCK:tombstone*/
  FOREACH v_id IN ARRAY p_cloud_ids LOOP
    v_row_id := NULL;
    EXECUTE format(
      'SELECT t.id, t.cloud_deal_id, t.removed_at, t.version FROM public.%I t
         JOIN public.cloud_deals d ON d.id = t.cloud_deal_id
        WHERE t.id = $1 AND t.owner_user_id = $2 /*OWNER:tombstone*/
          AND d.source_install_id = $3 /*INSTALL:tombstone*/
        FOR UPDATE OF t', v_tab)
      INTO v_row_id, v_row_deal, v_row_removed, v_row_version USING v_id, v_uid, p_source_install_id;
    IF v_row_id IS NULL THEN
      out := out || jsonb_build_object('cloud_id', v_id, 'status', 'not_found');
      CONTINUE;
    END IF;
    IF v_row_removed IS NOT NULL THEN
      out := out || jsonb_build_object('cloud_id', v_id, 'status', 'unchanged', 'version', v_row_version);
      CONTINUE;
    END IF;
    IF p_kind = 'party' THEN
      UPDATE public.cloud_deal_parties SET removed_at = now(), version = version + 1, updated_at = now(),
             display_name = NULL, company = NULL, emails = NULL, phones = NULL, notes = NULL
       WHERE id = v_row_id RETURNING version INTO v_row_version;
    ELSIF p_kind = 'checklist' THEN
      UPDATE public.cloud_deal_checklists SET removed_at = now(), version = version + 1, updated_at = now(), template_name = NULL
       WHERE id = v_row_id RETURNING version INTO v_row_version;
      UPDATE public.cloud_deal_checklist_items SET removed_at = now(), version = version + 1, updated_at = now(),
             title = '[removed]', description = NULL, note = NULL, links = '[]'::jsonb
       WHERE cloud_checklist_id = v_row_id AND cloud_deal_id = v_row_deal AND removed_at IS NULL;
    ELSIF p_kind = 'checklist_item' THEN
      UPDATE public.cloud_deal_checklist_items SET removed_at = now(), version = version + 1, updated_at = now(),
             title = '[removed]', description = NULL, note = NULL, links = '[]'::jsonb
       WHERE id = v_row_id RETURNING version INTO v_row_version;
    ELSIF p_kind = 'message' THEN
      UPDATE public.cloud_deal_messages SET removed_at = now(), version = version + 1, updated_at = now(),
             subject = NULL, body_text = NULL, body_truncated = false, participants = NULL          /*TOMB:scrub*/
       WHERE id = v_row_id RETURNING version INTO v_row_version;
    ELSE
      SELECT f.blob_id INTO v_blob FROM public.cloud_deal_files f WHERE f.id = v_row_id;
      UPDATE public.cloud_deal_files f SET removed_at = now(), version = version + 1, updated_at = now(),
             filename = NULL, blob_id = NULL
       WHERE f.id = v_row_id RETURNING f.version INTO v_row_version;
      v_fence := v_fence || v_blob;
    END IF;
    UPDATE public.cloud_deals SET last_synced_at = greatest(last_synced_at, v_now) WHERE id = v_row_deal;
    out := out || jsonb_build_object('cloud_id', v_id, 'status', 'removed', 'version', v_row_version);
  END LOOP;
  PERFORM public._cloud_fence_unreferenced(v_uid, v_fence);                                  /*TOMB:fence*/
  RETURN jsonb_build_object('ok', true, 'results', out);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_tombstone(uuid, uuid, text, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_tombstone(uuid, uuid, text, uuid[]) TO authenticated;

-- Owner only, any install, no entitlement.
DROP FUNCTION IF EXISTS public.cloud_delete_deal(uuid);
CREATE OR REPLACE FUNCTION public.cloud_delete_deal(p_expected_user_id uuid, p_cloud_deal_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); v_deal uuid; v_d jsonb; v_blobs uuid[]; v_fenced integer;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authorized'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:delete_deal*/
  IF p_cloud_deal_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  SELECT d.id INTO v_deal FROM public.cloud_deals d
   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:delete_deal*/
   FOR UPDATE;
  IF v_deal IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  SELECT jsonb_build_object(
    'parties', (SELECT count(*) FROM public.cloud_deal_parties WHERE cloud_deal_id = v_deal),
    'checklists', (SELECT count(*) FROM public.cloud_deal_checklists WHERE cloud_deal_id = v_deal),
    'checklist_items', (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = v_deal),
    'messages', (SELECT count(*) FROM public.cloud_deal_messages WHERE cloud_deal_id = v_deal),
    'files', (SELECT count(*) FROM public.cloud_deal_files WHERE cloud_deal_id = v_deal)) INTO v_d;
  SELECT array_agg(DISTINCT f.blob_id) INTO v_blobs FROM public.cloud_deal_files f
   WHERE f.cloud_deal_id = v_deal AND f.blob_id IS NOT NULL;
  DELETE FROM public.cloud_deals WHERE id = v_deal;
  v_fenced := public._cloud_fence_unreferenced(v_uid, v_blobs);
  RETURN jsonb_build_object('ok', true, 'deleted', v_d, 'blobs_fenced', v_fenced);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_delete_deal(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_delete_deal(uuid, uuid) TO authenticated;

DROP FUNCTION IF EXISTS public.cloud_mark_deal_synced(uuid, uuid);
CREATE OR REPLACE FUNCTION public.cloud_mark_deal_synced(p_expected_user_id uuid, p_source_install_id uuid, p_cloud_deal_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); v_at timestamptz; v_deal uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:mark_synced*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:mark_synced*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  SELECT d.id INTO v_deal FROM public.cloud_deals d
   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:mark_synced*/
     AND d.source_install_id = p_source_install_id                                           /*INSTALL:mark_synced*/
   FOR NO KEY UPDATE;
  IF v_deal IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  v_at := clock_timestamp();                                                                 /*CLOCK:mark*/
  UPDATE public.cloud_deals SET last_full_sync_at = v_at, last_synced_at = v_at WHERE id = v_deal;
  RETURN jsonb_build_object('ok', true, 'last_full_sync_at', v_at);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_mark_deal_synced(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_mark_deal_synced(uuid, uuid, uuid) TO authenticated;

-- ============================================================================ blobs
-- Client order for a blob: register; on state 'pending' confirm first and upload only when confirm
-- returns object_missing; on size_mismatch the blob is fenced and the next register returns a new id.
DROP FUNCTION IF EXISTS public.cloud_register_blob(text, bigint, text);
CREATE OR REPLACE FUNCTION public.cloud_register_blob(p_expected_user_id uuid, p_sha256 text, p_size_bytes bigint, p_mime_type text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); b record; v_id uuid := gen_random_uuid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:register*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:register*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  IF (p_sha256 ~ '^[0-9a-f]{64}$') IS NOT TRUE OR p_size_bytes IS NULL OR p_size_bytes <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
  END IF;
  IF p_size_bytes > 52428800 THEN RETURN jsonb_build_object('ok', false, 'error', 'too_large'); END IF;   /*CAP:blob*/
  INSERT INTO public.cloud_blobs (id, owner_user_id, sha256, size_bytes, mime_type, storage_path)
  VALUES (v_id, v_uid, p_sha256, p_size_bytes, p_mime_type, v_uid::text || '/' || v_id::text)
  ON CONFLICT (owner_user_id, sha256) WHERE purge_requested_at IS NULL DO NOTHING;
  SELECT * INTO b FROM public.cloud_blobs x
   WHERE x.owner_user_id = v_uid AND x.sha256 = p_sha256 AND x.purge_requested_at IS NULL FOR UPDATE;
  RETURN jsonb_build_object('ok', true, 'blob_id', b.id, 'storage_path', b.storage_path,
    'state', CASE WHEN b.id = v_id THEN 'new' WHEN b.uploaded_at IS NULL THEN 'pending' ELSE 'uploaded' END);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_register_blob(uuid, text, bigint, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_register_blob(uuid, text, bigint, text) TO authenticated;

DROP FUNCTION IF EXISTS public.cloud_confirm_blob(uuid);
CREATE OR REPLACE FUNCTION public.cloud_confirm_blob(p_expected_user_id uuid, p_blob_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); b record; v_size text; v_found boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:confirm*/
  SELECT * INTO b FROM public.cloud_blobs x
   WHERE x.id = p_blob_id AND x.owner_user_id = v_uid                                        /*OWNER:confirm*/
     AND x.purge_requested_at IS NULL FOR UPDATE;
  IF b.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF b.uploaded_at IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'state', 'uploaded'); END IF;   /*CONFIRM:already*/
  SELECT true, o.metadata ->> 'size' INTO v_found, v_size FROM storage.objects o
   WHERE o.bucket_id = 'cloud-deal-files' AND o.name = b.storage_path;
  IF v_found IS NOT TRUE THEN RETURN jsonb_build_object('ok', false, 'error', 'object_missing'); END IF;   /*CONFIRM:exists*/
  IF v_size IS DISTINCT FROM b.size_bytes::text THEN                                          /*CONFIRM:size*/
    UPDATE public.cloud_blobs SET purge_requested_at = now() WHERE id = b.id;                 /*CONFIRM:fence*/
    RETURN jsonb_build_object('ok', false, 'error', 'size_mismatch');
  END IF;
  UPDATE public.cloud_blobs SET uploaded_at = coalesce(uploaded_at, now()) WHERE id = b.id;
  RETURN jsonb_build_object('ok', true, 'state', 'uploaded');
END $f$;
REVOKE ALL ON FUNCTION public.cloud_confirm_blob(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_confirm_blob(uuid, uuid) TO authenticated;

-- ============================================================================ storage policies
DROP POLICY IF EXISTS "Cloud deal files: owner uploads registered blob" ON storage.objects;
CREATE POLICY "Cloud deal files: owner uploads registered blob" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'cloud-deal-files'
  AND split_part(objects.name, '/', 1) = (SELECT auth.uid())::text                 /*STO:ins:path*/
  AND (SELECT public.cloud_autosave_entitled())                                    /*STO:ins:entitled*/
  AND EXISTS (SELECT 1 FROM public.cloud_blobs b
               WHERE b.storage_path = objects.name
                 AND b.owner_user_id = (SELECT auth.uid())
                 AND b.uploaded_at IS NULL
                 AND b.purge_requested_at IS NULL)                                 /*STO:ins:blob*/
);

DROP POLICY IF EXISTS "Cloud deal files: owner reads live blob" ON storage.objects;
CREATE POLICY "Cloud deal files: owner reads live blob" ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'cloud-deal-files'
  AND split_part(objects.name, '/', 1) = (SELECT auth.uid())::text
  AND EXISTS (SELECT 1 FROM public.cloud_blobs b
               WHERE b.storage_path = objects.name
                 AND b.owner_user_id = (SELECT auth.uid())
                 AND b.purge_requested_at IS NULL)                                 /*STO:sel:fence*/
);
