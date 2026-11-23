-- ============================================================================
-- Migration: Keepr Cloud saves from one computer per account (BACKLOG-4263 sync 2.49, P1 / S1)
--
-- New table public.cloud_release_switches: one row (id = true), two switches, both false by default:
--   one_computer     while false, no computer is refused and cloud_claim_install never refuses;
--   messages_upload  read by later migrations; nothing in this file reads it except the state answer.
--   Turned on by a data UPDATE at release, for example:
--     UPDATE public.cloud_release_switches SET one_computer = true, updated_at = now() WHERE id;
-- New columns on public.cloud_autosave_settings: active_install_id uuid NULL, active_since timestamptz NULL (the
--   account's active computer and since when). Readable by the owner through the table's existing SELECT policy.
-- New tables public.cloud_computer_moves (one row per change of the active computer while one_computer is on) and
--   public.cloud_computer_move_notices (one row per such change, read later by the portal's email job).
-- Every new table: RLS on, no policy, ALL revoked from PUBLIC, anon, authenticated and service_role, TRUNCATE revoked
--   from anon and authenticated. Reached only through the functions below.
--
-- New functions:
--   _cloud_install_inactive(owner, install)  true when one_computer is on and the account's active computer is not
--     this install (a NULL active computer counts as not this install). No API role.
--   cloud_claim_install(p_expected_user_id, p_source_install_id, p_replace)  authenticated. Locks the caller's settings
--     row FOR UPDATE. Not entitled -> not_entitled. No active computer, or this one -> this one is active. Another one
--     active: one_computer on and p_replace false -> computer_not_active (with active_since); one_computer on and
--     p_replace true -> busy when a move was recorded for the account in the last minute, else this one becomes
--     active, one cloud_computer_moves row and one cloud_computer_move_notices row are written; one_computer off ->
--     this one becomes active, no move row. p_replace true also deletes this install's cloud_removed_installs row.
--     It changes no deal, party, todo, message, file or blob row.
--   cloud_computer_move_notice_claim(p_limit), cloud_computer_move_notice_done(p_id, p_attempts, p_status, p_error)
--     service_role only, refusing inside unless the request's role is service_role; same contract as
--     ai_app_notice_claim / ai_app_notice_done (20261118180000).
--
-- Replaced (pre-check below; each body is the head body plus the inserted lines, nothing else):
--   cloud_todo_push, cloud_upsert_deal, cloud_upsert_parties, cloud_upsert_messages, cloud_upsert_files,
--   cloud_mark_deal_synced (20261118110000) and cloud_tombstone (20261118120000): one gate right after the
--     existing install_removed gate (so after the settings FOR SHARE lock): computer_not_active, no write, when
--     _cloud_install_inactive(caller, install).
--   get_my_cloud_autosave_state (20261112190000): two keys added, 'active_install_id' and
--     'switches' {one_computer, messages_upload}. schema_version stays 1. Still STABLE; reads only.
--   set_my_cloud_autosave: new signature (p_expected_user_id, p_enabled, p_notice_version, p_source_install_id
--     DEFAULT NULL); the 3-argument version (20261118110000) is dropped first. Turn-off: while one_computer is on, a
--     computer is active and the caller is licensed, refused install_required (no install sent) or
--     computer_not_active (another computer is active), nothing deleted; otherwise as before, and the active
--     computer is cleared. Turn-on unchanged.
-- New signatures (old ones from 20261112190000 dropped; no client calls them):
--   cloud_register_blob(p_expected_user_id, p_source_install_id, p_sha256, p_size_bytes, p_mime_type) and
--   cloud_confirm_blob(p_expected_user_id, p_source_install_id, p_blob_id): the install is required and gated as above.
--   cloud_confirm_blob now locks the caller's settings row FOR SHARE before its gate.
-- Grants: every new or replaced function has EXECUTE revoked from PUBLIC, anon, authenticated and service_role on its
--   full signature, then granted to the one role that calls it. Every SECURITY DEFINER function checks its caller.
--
-- Existing rows: for each account with Keepr Cloud on and no active computer, the active computer is set to the
--   install whose live deals were saved most recently (greatest max(last_synced_at); ties to the lowest install id).
--   Accounts with no live deal, or with Keepr Cloud off, stay NULL.
-- Locks: the new tables' foreign keys take SHARE ROW EXCLUSIVE on auth.users until commit; ADD COLUMN takes ACCESS
--   EXCLUSIVE on cloud_autosave_settings until commit (catalog-only; both columns are NULL with no default), placed
--   after every function so it is held for the shortest time; the existing-rows UPDATE locks one settings row per
--   account it sets. lock_timeout 3s: if a lock is not obtained in 3 seconds the migration fails and nothing is applied.
-- Pre-check: each function this file replaces or drops is at the body its head migration wrote, or already at this
--   file's body (dropped signatures: absent, with the new one at this file's body); otherwise nothing is applied.
-- Re-runnable: CREATE TABLE / INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS.
-- Rollback: supabase/tests/backlog-4263-sync2-s1/rollback-20261123100000.sql.
-- ============================================================================
DO $pre4263s1$
DECLARE r record; v text; w text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.cloud_todo_push(uuid,uuid,text,jsonb)', '189633a74b57668ac2c19332c0009841', '300de7ee13eeffb029773b1c41a900b7'),
      ('public.cloud_upsert_deal(uuid,jsonb)', '3cea5805da6d1fbd7667f92cf6c248b7', '49fe9c6b681dadbc5311c30f4d2f472d'),
      ('public.cloud_upsert_parties(uuid,uuid,uuid,jsonb)', 'b2e26a903c5d54f583ba0ea6881c63af', '9bd37a79d81a1d465079613861038f2a'),
      ('public.cloud_upsert_messages(uuid,uuid,uuid,jsonb)', '05081a0a8dac4e5f725d039730465189', 'a71abe9743d2f9b6557c261ec09959a9'),
      ('public.cloud_upsert_files(uuid,uuid,uuid,jsonb)', '338cd27fd440085ee2ac7f70b98c9dd5', '0551bc2e4d92628df919008d28bc7b65'),
      ('public.cloud_mark_deal_synced(uuid,uuid,uuid)', '99932f6b2549c0d94519e4bef59e26e6', 'd36b57d8ccd8523c1b25b45451a4893d'),
      ('public.cloud_tombstone(uuid,uuid,text,uuid[])', 'd687b1d11184ec4ebb519d12935b5fd1', '8397326470b7c4eacb4862f46d01b6d2'),
      ('public.get_my_cloud_autosave_state()', '9d146e4f0f190c7c2d778926eff87671', 'b6218470f03cbd8e63cd26d82106e8f9'))
      x(sig, head, mine) LOOP
    SELECT md5(p.prosrc) INTO v FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v IS NULL OR v NOT IN (r.head, r.mine) THEN
      RAISE EXCEPTION 'BACKLOG-4263 S1: % is not at the expected body (md5 %)', r.sig, coalesce(v, 'missing');
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM (VALUES
      ('public.set_my_cloud_autosave(uuid,boolean,integer)', '211f620b80d0ec5d34abdac2d6ed97b5',
       'public.set_my_cloud_autosave(uuid,boolean,integer,uuid)', 'a7c3e96f6503fadf85dc2f6980d8942d'),
      ('public.cloud_register_blob(uuid,text,bigint,text)', 'e06184ce7692f7daff90c50e50291345',
       'public.cloud_register_blob(uuid,uuid,text,bigint,text)', 'f0bdbd8910e03c204f39199427a1ee53'),
      ('public.cloud_confirm_blob(uuid,uuid)', '3f99a4e25c84b3320729b99fdd32ba6d',
       'public.cloud_confirm_blob(uuid,uuid,uuid)', '5d61fa5c5611035c62e46747e4b817b0'))
      x(old_sig, head, new_sig, mine) LOOP
    SELECT md5(p.prosrc) INTO v FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.old_sig);
    SELECT md5(p.prosrc) INTO w FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.new_sig);
    IF NOT ((v = r.head AND w IS NULL) OR (v IS NULL AND w = r.mine)) THEN
      RAISE EXCEPTION 'BACKLOG-4263 S1: % / % not at the expected bodies (md5 % / %)', r.old_sig, r.new_sig,
        coalesce(v, 'missing'), coalesce(w, 'missing');
    END IF;
  END LOOP;
  IF to_regclass('public.cloud_autosave_settings') IS NULL OR to_regclass('public.cloud_removed_installs') IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-4263 S1: requires 20261112190000 and 20261118110000';
  END IF;
END
$pre4263s1$;
SET LOCAL lock_timeout = '3s';

-- ============================================================================ tables
CREATE TABLE IF NOT EXISTS public.cloud_release_switches (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  one_computer    boolean NOT NULL DEFAULT false,
  messages_upload boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cloud_release_switches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cloud_release_switches FROM PUBLIC, anon, authenticated, service_role;
REVOKE TRUNCATE ON TABLE public.cloud_release_switches FROM anon, authenticated;
INSERT INTO public.cloud_release_switches (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.cloud_computer_moves (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  from_install_id uuid NULL,
  to_install_id   uuid NOT NULL,
  moved_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cloud_computer_moves_owner_idx ON public.cloud_computer_moves (owner_user_id, moved_at);
ALTER TABLE public.cloud_computer_moves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cloud_computer_moves FROM PUBLIC, anon, authenticated, service_role;
REVOKE TRUNCATE ON TABLE public.cloud_computer_moves FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.cloud_computer_move_notices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  move_id     uuid NOT NULL REFERENCES public.cloud_computer_moves (id) ON DELETE CASCADE,
  moved_at    timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'sent', 'queued', 'failed', 'skipped')),
  attempts    smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz NULL,
  sent_at     timestamptz NULL,
  last_error  text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 40)
);
CREATE INDEX IF NOT EXISTS cloud_computer_move_notices_due_idx ON public.cloud_computer_move_notices (moved_at) WHERE status = 'due';
CREATE INDEX IF NOT EXISTS cloud_computer_move_notices_user_idx ON public.cloud_computer_move_notices (user_id);
CREATE INDEX IF NOT EXISTS cloud_computer_move_notices_move_idx ON public.cloud_computer_move_notices (move_id);
ALTER TABLE public.cloud_computer_move_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cloud_computer_move_notices FROM PUBLIC, anon, authenticated, service_role;
REVOKE TRUNCATE ON TABLE public.cloud_computer_move_notices FROM anon, authenticated;

-- ============================================================================ the gate
-- True when one_computer is on and the account's active computer is not p_install (NULL counts as not p_install).
-- Called by the install-scoped writers after their settings lock. One place to lift the rule.
CREATE OR REPLACE FUNCTION public._cloud_install_inactive(p_owner uuid, p_install uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = '' AS $f$
BEGIN
  RETURN coalesce((SELECT w.one_computer FROM public.cloud_release_switches w WHERE w.id), false)          /*INACTIVE:switch*/
         AND (SELECT s.active_install_id FROM public.cloud_autosave_settings s WHERE s.user_id = p_owner)
             IS DISTINCT FROM p_install;                                                                  /*INACTIVE:distinct*/
END $f$;
REVOKE ALL ON FUNCTION public._cloud_install_inactive(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================ replaced: install-scoped writers
-- Each body is the head body with one gate inserted right after its install_removed gate.
CREATE OR REPLACE FUNCTION public.cloud_todo_push(p_expected_user_id uuid, p_source_install_id uuid, p_sent_at text, p_ops jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); v_recv timestamptz := clock_timestamp(); v_sent timestamptz; v_ed timestamptz;
        v_age interval; op jsonb; v_ops jsonb := '[]'::jsonb; v_unk boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authorized'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:push*/
  IF p_source_install_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF public._cloud_install_removed(v_uid, p_source_install_id) THEN                              /*GATE:install:push*/
    RETURN jsonb_build_object('ok', false, 'error', 'install_removed');
  END IF;
  IF public._cloud_install_inactive(v_uid, p_source_install_id) THEN                         /*GATE:active:push*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');
  END IF;
  IF jsonb_typeof(p_ops) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  IF jsonb_array_length(p_ops) > 200 OR octet_length(p_ops::text) > 1048576 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;
  v_sent := CASE WHEN pg_input_is_valid(p_sent_at, 'timestamptz') THEN p_sent_at::timestamptz END;
  FOR op IN SELECT value FROM jsonb_array_elements(p_ops) LOOP
    IF jsonb_typeof(op) = 'object' THEN
      v_ed := CASE WHEN jsonb_typeof(op -> 'edited_at') = 'string' AND pg_input_is_valid(op ->> 'edited_at', 'timestamptz')
                   THEN (op ->> 'edited_at')::timestamptz END;
      v_age := v_sent - v_ed;                                                                       /*CLOCK:age*/
      v_unk := v_sent IS NULL OR v_ed IS NULL OR v_age < interval '0' OR v_age > interval '365 days'   /*CLOCK:unknowable*/
               OR isfinite(v_age) IS NOT TRUE OR (op ->> 'clock_stepped') = 'true';                /*CLOCK:stepped*/
      op := (op - '_eff') || jsonb_build_object('_eff', CASE WHEN v_unk THEN '-infinity' ELSE (v_recv - v_age)::text END);
    END IF;
    v_ops := v_ops || jsonb_build_array(op);
  END LOOP;
  RETURN public._cloud_todo_apply(v_uid, jsonb_build_object('kind', 'desktop', 'ref', p_source_install_id::text,
           'install_id', p_source_install_id, 'label', 'Keepr desktop'), v_ops);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_todo_push(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_todo_push(uuid, uuid, text, jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.cloud_upsert_deal(p_expected_user_id uuid, p_deal jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263*/
DECLARE v_uid uuid := auth.uid(); v_local text; v_hash text; v_base bigint; v_inst uuid; v_org uuid;
        d record; v_status text; v_det text; v_st text; v_bad text; v_now timestamptz; v_restored boolean := false;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:deal*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:deal*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  PERFORM public._cloud_todo_take_seq(v_uid, 0);                                             /*HEAD:deal*/
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
  IF public._cloud_install_removed(v_uid, v_inst) THEN                                          /*GATE:install:deal*/
    RETURN jsonb_build_object('ok', false, 'error', 'install_removed');
  END IF;
  IF public._cloud_install_inactive(v_uid, v_inst) THEN                                      /*GATE:active:deal*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');
  END IF;
  IF p_deal ->> 'organization_id' IS NOT NULL THEN
    SELECT o.id INTO v_org FROM public.organizations o
      JOIN public.organization_members m ON m.organization_id = o.id AND m.user_id = v_uid
     WHERE o.id = (p_deal ->> 'organization_id')::uuid
       AND o.personal_owner_user_id IS NULL                                                  /*ORG:notpersonal*/
       AND public.member_status_grants_access(m.license_status);                             /*ORG:member*/
    IF v_org IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_organization'); END IF;
  END IF;
  v_det := p_deal ->> 'detection_status'; v_st := p_deal ->> 'status';
  IF NOT EXISTS (SELECT 1 FROM public.cloud_deals x
                  WHERE x.owner_user_id = v_uid AND x.source_install_id = v_inst AND x.local_transaction_id = v_local) THEN
    INSERT INTO public.cloud_deals (owner_user_id, source_install_id, local_transaction_id, content_hash, version, change_seq)
    VALUES (v_uid, v_inst, v_local, v_hash, 0, (public._cloud_todo_take_seq(v_uid, 1))[1])
    ON CONFLICT (owner_user_id, source_install_id, local_transaction_id) DO NOTHING;
  END IF;
  SELECT * INTO d FROM public.cloud_deals x
   WHERE x.owner_user_id = v_uid AND x.source_install_id = v_inst AND x.local_transaction_id = v_local FOR UPDATE;
  IF d.removed_at IS NOT NULL THEN                                                            /*DEAL:unremove*/
    PERFORM public._cloud_todo_unremove_deal(v_uid, d.id, jsonb_build_object('kind', 'desktop', 'ref', v_inst::text, 'label', 'Keepr desktop'));
    v_restored := true;
    SELECT * INTO d FROM public.cloud_deals x WHERE x.id = d.id;
  END IF;
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
    'local_id', v_local, 'cloud_id', d.id, 'version', d.version, 'content_hash', d.content_hash, 'status', v_status,
    'restored', v_restored)));
END $f$;
REVOKE ALL ON FUNCTION public.cloud_upsert_deal(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_upsert_deal(uuid, jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.cloud_upsert_parties(p_expected_user_id uuid, p_source_install_id uuid, p_cloud_deal_id uuid, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263*/
DECLARE v_uid uuid := auth.uid(); v_deal uuid; r jsonb; i integer := 0; out jsonb := '[]'::jsonb;
        cur record; v_status text; v_bad text; v_withheld boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:parties*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:parties*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  IF public._cloud_install_removed(v_uid, p_source_install_id) THEN                       /*GATE:install:parties*/
    RETURN jsonb_build_object('ok', false, 'error', 'install_removed');
  END IF;
  IF public._cloud_install_inactive(v_uid, p_source_install_id) THEN                         /*GATE:active:parties*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');
  END IF;
  SELECT d.id INTO v_deal FROM public.cloud_deals d
   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:parties*/
     AND d.source_install_id = p_source_install_id                                           /*INSTALL:parties*/
     AND d.removed_at IS NULL                                                             /*GATE:live:parties*/
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
    IF v_status = 'unchanged' AND v_withheld AND NOT cur.details_withheld THEN v_status := 'applied'; END IF;   /*PTY:flip*/
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
CREATE OR REPLACE FUNCTION public.cloud_upsert_messages(p_expected_user_id uuid, p_source_install_id uuid, p_cloud_deal_id uuid, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263*/
DECLARE v_uid uuid := auth.uid(); v_deal uuid; r jsonb; i integer := 0; out jsonb := '[]'::jsonb;
        cur record; v_status text; v_body text; v_trunc boolean; v_kind text; v_state text; v_bad text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:messages*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:messages*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  IF public._cloud_install_removed(v_uid, p_source_install_id) THEN                       /*GATE:install:messages*/
    RETURN jsonb_build_object('ok', false, 'error', 'install_removed');
  END IF;
  IF public._cloud_install_inactive(v_uid, p_source_install_id) THEN                         /*GATE:active:messages*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');
  END IF;
  SELECT d.id INTO v_deal FROM public.cloud_deals d
   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:messages*/
     AND d.source_install_id = p_source_install_id                                           /*INSTALL:messages*/
     AND d.removed_at IS NULL                                                             /*GATE:live:messages*/
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
CREATE OR REPLACE FUNCTION public.cloud_upsert_files(p_expected_user_id uuid, p_source_install_id uuid, p_cloud_deal_id uuid, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263*/
DECLARE v_uid uuid := auth.uid(); v_deal uuid; r jsonb; i integer := 0; out jsonb := '[]'::jsonb;
        cur record; v_status text; v_bad text; v_msg uuid; v_blob uuid; v_old_blob uuid; v_old_blobs uuid[] := '{}';
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:files*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:files*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  IF public._cloud_install_removed(v_uid, p_source_install_id) THEN                       /*GATE:install:files*/
    RETURN jsonb_build_object('ok', false, 'error', 'install_removed');
  END IF;
  IF public._cloud_install_inactive(v_uid, p_source_install_id) THEN                         /*GATE:active:files*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');
  END IF;
  SELECT d.id INTO v_deal FROM public.cloud_deals d
   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:files*/
     AND d.source_install_id = p_source_install_id                                           /*INSTALL:files*/
     AND d.removed_at IS NULL                                                             /*GATE:live:files*/
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
CREATE OR REPLACE FUNCTION public.cloud_mark_deal_synced(p_expected_user_id uuid, p_source_install_id uuid, p_cloud_deal_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263*/
DECLARE v_uid uuid := auth.uid(); v_at timestamptz; v_deal uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:mark_synced*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:mark_synced*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  IF public._cloud_install_removed(v_uid, p_source_install_id) THEN                       /*GATE:install:mark_synced*/
    RETURN jsonb_build_object('ok', false, 'error', 'install_removed');
  END IF;
  IF public._cloud_install_inactive(v_uid, p_source_install_id) THEN                         /*GATE:active:mark_synced*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');
  END IF;
  SELECT d.id INTO v_deal FROM public.cloud_deals d
   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:mark_synced*/
     AND d.source_install_id = p_source_install_id                                           /*INSTALL:mark_synced*/
     AND d.removed_at IS NULL                                                             /*GATE:live:mark_synced*/
   FOR NO KEY UPDATE;
  IF v_deal IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  v_at := clock_timestamp();                                                                 /*CLOCK:mark*/
  UPDATE public.cloud_deals SET last_full_sync_at = v_at, last_synced_at = v_at WHERE id = v_deal;
  RETURN jsonb_build_object('ok', true, 'last_full_sync_at', v_at);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_mark_deal_synced(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_mark_deal_synced(uuid, uuid, uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.cloud_tombstone(p_expected_user_id uuid, p_source_install_id uuid, p_kind text, p_cloud_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263-4a*/
DECLARE v_uid uuid := auth.uid(); v_tab text; v_id uuid; out jsonb := '[]'::jsonb;
        v_row_id uuid; v_row_deal uuid; v_row_removed timestamptz; v_row_version bigint; v_blob uuid; v_deals uuid[];
        v_fence uuid[] := '{}'; v_now timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authorized'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:tombstone*/
  -- checklists and items are todo changes (cloud_todo_push) since 20261118120000: no arm for them here
  v_tab := CASE p_kind WHEN 'party' THEN 'cloud_deal_parties' WHEN 'message' THEN 'cloud_deal_messages'
                       WHEN 'file' THEN 'cloud_deal_files' END;
  IF v_tab IS NULL OR p_source_install_id IS NULL OR p_cloud_ids IS NULL OR cardinality(p_cloud_ids) > 1000 THEN   /*CAP:tombstone*/
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
  END IF;
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public._cloud_install_removed(v_uid, p_source_install_id) THEN                       /*GATE:install:tombstone*/
    RETURN jsonb_build_object('ok', false, 'error', 'install_removed');
  END IF;
  IF public._cloud_install_inactive(v_uid, p_source_install_id) THEN                         /*GATE:active:tombstone*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');
  END IF;
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

-- ============================================================================ replaced: state answer and on / off
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
    'active_install_id', s.active_install_id,                                                         /*STATE:active*/
    'switches', coalesce((SELECT jsonb_build_object('one_computer', w.one_computer, 'messages_upload', w.messages_upload)
                            FROM public.cloud_release_switches w WHERE w.id),
                         jsonb_build_object('one_computer', false, 'messages_upload', false)),         /*STATE:switches*/
    'storage', jsonb_build_object('used_bytes', v_used, 'quota_bytes', NULL));
END $f$;
REVOKE ALL ON FUNCTION public.get_my_cloud_autosave_state() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_cloud_autosave_state() TO authenticated;
DROP FUNCTION IF EXISTS public.set_my_cloud_autosave(uuid, boolean, integer);
CREATE OR REPLACE FUNCTION public.set_my_cloud_autosave(p_expected_user_id uuid, p_enabled boolean, p_notice_version integer DEFAULT NULL,
                                                      p_source_install_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263*/
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
  -- One computer (20261123100000): while the switch is on, a computer is active and the caller is licensed, only the
  -- active computer turns off.
  IF coalesce((SELECT w.one_computer FROM public.cloud_release_switches w WHERE w.id), false)                 /*SET:active:switch*/
     AND (SELECT x.active_install_id FROM public.cloud_autosave_settings x WHERE x.user_id = v_uid) IS NOT NULL
     AND (SELECT l.licensed FROM public._cloud_autosave_license(v_uid) l) IS TRUE THEN                        /*SET:active:licence*/
    IF p_source_install_id IS NULL THEN                                                                      /*SET:active:required*/
      RETURN jsonb_build_object('success', false, 'error', 'install_required');
    END IF;
    IF p_source_install_id IS DISTINCT FROM
       (SELECT x.active_install_id FROM public.cloud_autosave_settings x WHERE x.user_id = v_uid) THEN       /*SET:active:other*/
      RETURN jsonb_build_object('success', false, 'error', 'computer_not_active');
    END IF;
  END IF;
  -- Off: one unit. Any error undoes all of it and the call is refused.
  BEGIN
    UPDATE public.cloud_autosave_settings SET enabled = false, disabled_at = now(), updated_at = now() WHERE user_id = v_uid;
    UPDATE public.cloud_autosave_settings SET active_install_id = NULL, active_since = NULL WHERE user_id = v_uid;   /*SET:active:clear*/
    PERFORM 1 FROM public.cloud_todo_feed_head h WHERE h.owner_user_id = v_uid FOR UPDATE;      /*SET:head*/
    SELECT jsonb_build_object(
      'deals', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = v_uid),
      'parties', (SELECT count(*) FROM public.cloud_deal_parties WHERE owner_user_id = v_uid),
      'checklists', (SELECT count(*) FROM public.cloud_deal_checklists WHERE owner_user_id = v_uid),
      'checklist_items', (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE owner_user_id = v_uid),
      'messages', (SELECT count(*) FROM public.cloud_deal_messages WHERE owner_user_id = v_uid),
      'files', (SELECT count(*) FROM public.cloud_deal_files WHERE owner_user_id = v_uid),
      'todo_history', (SELECT count(*) FROM public.cloud_todo_history WHERE owner_user_id = v_uid)) INTO v_d;
    DELETE FROM public.cloud_todo_history WHERE owner_user_id = v_uid;                            /*SET:history*/
    DELETE FROM public.cloud_deals WHERE owner_user_id = v_uid;                                  /*SET:delete*/
    DELETE FROM public.cloud_todo_ops WHERE owner_user_id = v_uid;                                /*SET:ops*/
    DELETE FROM public.cloud_removed_installs WHERE owner_user_id = v_uid;                        /*SET:installs*/
    DELETE FROM public.cloud_todo_feed_head WHERE owner_user_id = v_uid;                          /*SET:feed_head*/
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
REVOKE ALL ON FUNCTION public.set_my_cloud_autosave(uuid, boolean, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_my_cloud_autosave(uuid, boolean, integer, uuid) TO authenticated;

-- ============================================================================ blobs: new signatures with the install
DROP FUNCTION IF EXISTS public.cloud_register_blob(uuid, text, bigint, text);
CREATE OR REPLACE FUNCTION public.cloud_register_blob(p_expected_user_id uuid, p_source_install_id uuid, p_sha256 text, p_size_bytes bigint,
                                                      p_mime_type text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263-s1*/
DECLARE v_uid uuid := auth.uid(); b record; v_id uuid := gen_random_uuid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:register*/
  IF p_source_install_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;                  /*LOCK:register*/
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:register*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  IF public._cloud_install_inactive(v_uid, p_source_install_id) THEN                           /*GATE:active:register*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');
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
REVOKE ALL ON FUNCTION public.cloud_register_blob(uuid, uuid, text, bigint, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_register_blob(uuid, uuid, text, bigint, text) TO authenticated;

DROP FUNCTION IF EXISTS public.cloud_confirm_blob(uuid, uuid);
CREATE OR REPLACE FUNCTION public.cloud_confirm_blob(p_expected_user_id uuid, p_source_install_id uuid, p_blob_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263-s1*/
DECLARE v_uid uuid := auth.uid(); b record; v_size text; v_found boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:confirm*/
  IF p_source_install_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;                  /*LOCK:confirm*/
  IF public._cloud_install_inactive(v_uid, p_source_install_id) THEN                           /*GATE:active:confirm*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');
  END IF;
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
REVOKE ALL ON FUNCTION public.cloud_confirm_blob(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_confirm_blob(uuid, uuid, uuid) TO authenticated;

-- ============================================================================ claim
CREATE OR REPLACE FUNCTION public.cloud_claim_install(p_expected_user_id uuid, p_source_install_id uuid, p_replace boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263-s1*/
DECLARE v_uid uuid := auth.uid(); v_old uuid; v_since timestamptz; v_on boolean; v_move uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authorized'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:claim*/
  IF p_source_install_id IS NULL OR p_replace IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  INSERT INTO public.cloud_autosave_settings (user_id) VALUES (v_uid) ON CONFLICT (user_id) DO NOTHING;
  SELECT x.active_install_id, x.active_since INTO v_old, v_since
    FROM public.cloud_autosave_settings x WHERE x.user_id = v_uid FOR UPDATE;                  /*CLAIM:lock*/
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                         /*CLAIM:entitled*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  IF v_old = p_source_install_id THEN                                                          /*CLAIM:same*/
    RETURN jsonb_build_object('ok', true, 'active', true);
  END IF;
  IF v_old IS NULL THEN                                                                        /*CLAIM:first*/
    UPDATE public.cloud_autosave_settings SET active_install_id = p_source_install_id, active_since = now(), updated_at = now()
     WHERE user_id = v_uid;
    RETURN jsonb_build_object('ok', true, 'active', true);
  END IF;
  v_on := coalesce((SELECT w.one_computer FROM public.cloud_release_switches w WHERE w.id), false);   /*CLAIM:switch*/
  IF v_on AND NOT p_replace THEN                                                               /*CLAIM:refuse*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active', 'active_since', v_since);
  END IF;
  IF v_on AND EXISTS (SELECT 1 FROM public.cloud_computer_moves m
                       WHERE m.owner_user_id = v_uid AND m.moved_at > now() - interval '1 minute') THEN   /*CLAIM:rate*/
    RETURN jsonb_build_object('ok', false, 'error', 'busy');
  END IF;
  UPDATE public.cloud_autosave_settings SET active_install_id = p_source_install_id, active_since = now(), updated_at = now()
   WHERE user_id = v_uid;                                                                      /*CLAIM:move_active*/
  IF p_replace THEN
    DELETE FROM public.cloud_removed_installs
     WHERE owner_user_id = v_uid AND source_install_id = p_source_install_id;                  /*CLAIM:reclaim*/
  END IF;
  IF v_on THEN                                                                                 /*CLAIM:record*/
    INSERT INTO public.cloud_computer_moves (owner_user_id, from_install_id, to_install_id)
    VALUES (v_uid, v_old, p_source_install_id) RETURNING id INTO v_move;
    INSERT INTO public.cloud_computer_move_notices (user_id, move_id) VALUES (v_uid, v_move);   /*CLAIM:notice*/
  END IF;
  RETURN jsonb_build_object('ok', true, 'active', true, 'replaced', v_old);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_claim_install(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_claim_install(uuid, uuid, boolean) TO authenticated;

-- ============================================================================ move email job (service_role)
CREATE OR REPLACE FUNCTION public.cloud_computer_move_notice_claim(p_limit integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_rows jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN   /*CALLER:move_claim*/
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  UPDATE public.cloud_computer_move_notices n
     SET status = 'skipped', last_error = 'stale', lease_until = NULL
   WHERE n.id IN (SELECT x.id FROM public.cloud_computer_move_notices x
                   WHERE x.status = 'due' AND x.moved_at < now() - interval '2 days'
                     AND (x.lease_until IS NULL OR x.lease_until <= now())
                   LIMIT 500 FOR UPDATE SKIP LOCKED);
  UPDATE public.cloud_computer_move_notices n
     SET status = 'failed', last_error = coalesce(n.last_error, 'attempts'), lease_until = NULL
   WHERE n.id IN (SELECT x.id FROM public.cloud_computer_move_notices x
                   WHERE x.status = 'due' AND x.attempts >= 5 AND (x.lease_until IS NULL OR x.lease_until <= now())
                   LIMIT 500 FOR UPDATE SKIP LOCKED);
  DELETE FROM public.cloud_computer_move_notices n
   WHERE n.id IN (SELECT x.id FROM public.cloud_computer_move_notices x
                   WHERE x.status IN ('sent', 'queued', 'failed', 'skipped') AND x.moved_at < now() - interval '30 days'
                   LIMIT 500 FOR UPDATE SKIP LOCKED);
  WITH c AS (
    SELECT x.id FROM public.cloud_computer_move_notices x
     WHERE x.status = 'due'
       AND x.attempts < 5
       AND (x.lease_until IS NULL OR x.lease_until <= now())
       AND x.moved_at >= now() - interval '2 days'
     ORDER BY x.moved_at, x.id
     LIMIT least(greatest(coalesce(p_limit, 0), 0), 50)
     FOR UPDATE SKIP LOCKED),
  u AS (
    UPDATE public.cloud_computer_move_notices n
       SET attempts = n.attempts + 1, lease_until = now() + interval '5 minutes'
      FROM c
     WHERE n.id = c.id
    RETURNING n.id, n.user_id, n.moved_at, n.attempts)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'user_id', u.user_id, 'moved_at', u.moved_at, 'attempts', u.attempts)
                            ORDER BY u.moved_at, u.id), '[]'::jsonb)
    INTO v_rows
    FROM u;
  RETURN v_rows;
END
$fn$;
REVOKE ALL ON FUNCTION public.cloud_computer_move_notice_claim(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_computer_move_notice_claim(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.cloud_computer_move_notice_done(p_id uuid, p_attempts integer, p_status text, p_error text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_n integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN   /*CALLER:move_done*/
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF (p_status IN ('due', 'sent', 'queued', 'failed', 'skipped')) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'cloud_computer_move_notice_done: unknown status';
  END IF;
  UPDATE public.cloud_computer_move_notices n
     SET status = p_status,
         last_error = left(p_error, 40),
         lease_until = NULL,
         sent_at = CASE WHEN p_status IN ('sent', 'queued') THEN now() ELSE n.sent_at END
   WHERE n.id = p_id
     AND n.attempts = p_attempts
     AND n.status = 'due';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END
$fn$;
REVOKE ALL ON FUNCTION public.cloud_computer_move_notice_done(uuid, integer, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_computer_move_notice_done(uuid, integer, text, text) TO service_role;

-- ============================================================================ the active computer: columns and existing rows
ALTER TABLE public.cloud_autosave_settings
  ADD COLUMN IF NOT EXISTS active_install_id uuid NULL,
  ADD COLUMN IF NOT EXISTS active_since      timestamptz NULL;

-- Keepr Cloud on, no active computer yet: the install whose live deals were saved most recently.
DO $backfill4263s1$
BEGIN
  UPDATE public.cloud_autosave_settings s
     SET active_install_id = w.source_install_id, active_since = now()
    FROM (SELECT DISTINCT ON (d.owner_user_id) d.owner_user_id, d.source_install_id
            FROM public.cloud_deals d
           WHERE d.removed_at IS NULL
           GROUP BY d.owner_user_id, d.source_install_id
           ORDER BY d.owner_user_id, max(d.last_synced_at) DESC, d.source_install_id) w        /*BACKFILL:latest*/
   WHERE s.user_id = w.owner_user_id AND s.enabled AND s.active_install_id IS NULL;            /*BACKFILL:scope*/
END
$backfill4263s1$;

-- ============================================================================ post-check
DO $post4263s1$
DECLARE r record; v text; bad text := '';
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public._cloud_install_inactive(uuid,uuid)', 'ecc15a2eb8a3928f86aa0d2f969a9b3f', false, 'none'),
      ('public.cloud_todo_push(uuid,uuid,text,jsonb)', '300de7ee13eeffb029773b1c41a900b7', true, 'authenticated'),
      ('public.cloud_upsert_deal(uuid,jsonb)', '49fe9c6b681dadbc5311c30f4d2f472d', true, 'authenticated'),
      ('public.cloud_upsert_parties(uuid,uuid,uuid,jsonb)', '9bd37a79d81a1d465079613861038f2a', true, 'authenticated'),
      ('public.cloud_upsert_messages(uuid,uuid,uuid,jsonb)', 'a71abe9743d2f9b6557c261ec09959a9', true, 'authenticated'),
      ('public.cloud_upsert_files(uuid,uuid,uuid,jsonb)', '0551bc2e4d92628df919008d28bc7b65', true, 'authenticated'),
      ('public.cloud_mark_deal_synced(uuid,uuid,uuid)', 'd36b57d8ccd8523c1b25b45451a4893d', true, 'authenticated'),
      ('public.cloud_tombstone(uuid,uuid,text,uuid[])', '8397326470b7c4eacb4862f46d01b6d2', true, 'authenticated'),
      ('public.get_my_cloud_autosave_state()', 'b6218470f03cbd8e63cd26d82106e8f9', true, 'authenticated'),
      ('public.set_my_cloud_autosave(uuid,boolean,integer,uuid)', 'a7c3e96f6503fadf85dc2f6980d8942d', true, 'authenticated'),
      ('public.cloud_register_blob(uuid,uuid,text,bigint,text)', 'f0bdbd8910e03c204f39199427a1ee53', true, 'authenticated'),
      ('public.cloud_confirm_blob(uuid,uuid,uuid)', '5d61fa5c5611035c62e46747e4b817b0', true, 'authenticated'),
      ('public.cloud_claim_install(uuid,uuid,boolean)', '93fe1f5c48855e5f70950dcb7b5fca09', true, 'authenticated'),
      ('public.cloud_computer_move_notice_claim(integer)', '7e53fdbc192927ebfffc815cb37c1bc4', true, 'service_role'),
      ('public.cloud_computer_move_notice_done(uuid,integer,text,text)', 'b4b115cf7f04d19977baf0b5a622032a', true, 'service_role'))
      x(sig, want_md5, secdef, role) LOOP
    SELECT CASE
             WHEN p.oid IS NULL THEN 'missing'
             WHEN md5(p.prosrc) <> r.want_md5 THEN 'md5'
             WHEN p.prosecdef IS DISTINCT FROM r.secdef THEN 'security definer'
             WHEN array_to_string(p.proconfig, ',') IS DISTINCT FROM 'search_path=""' THEN 'search_path'
             WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'anon'
             WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') IS DISTINCT FROM (r.role = 'authenticated') THEN 'authenticated'
             WHEN has_function_privilege('service_role', p.oid, 'EXECUTE') IS DISTINCT FROM (r.role = 'service_role') THEN 'service_role'
             ELSE NULL END
      INTO v
      FROM (SELECT to_regprocedure(r.sig) AS oid) o LEFT JOIN pg_catalog.pg_proc p ON p.oid = o.oid;
    IF v IS NOT NULL THEN bad := bad || r.sig || ' ' || v || '; '; END IF;
  END LOOP;
  IF (SELECT provolatile FROM pg_catalog.pg_proc WHERE oid = 'public.get_my_cloud_autosave_state()'::regprocedure) <> 's' THEN
    bad := bad || 'state answer not STABLE; ';
  END IF;
  IF to_regprocedure('public.set_my_cloud_autosave(uuid,boolean,integer)') IS NOT NULL
     OR to_regprocedure('public.cloud_register_blob(uuid,text,bigint,text)') IS NOT NULL
     OR to_regprocedure('public.cloud_confirm_blob(uuid,uuid)') IS NOT NULL THEN
    bad := bad || 'an earlier signature is still present; ';
  END IF;
  FOR r IN SELECT c.oid, c.relname FROM pg_catalog.pg_class c
            WHERE c.oid IN ('public.cloud_release_switches'::regclass, 'public.cloud_computer_moves'::regclass,
                            'public.cloud_computer_move_notices'::regclass) LOOP
    IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = r.oid)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy y WHERE y.polrelid = r.oid)
       OR has_table_privilege('anon', r.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('authenticated', r.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('service_role', r.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      bad := bad || r.relname || ' not closed; ';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.cloud_autosave_settings'::regclass AND NOT a.attisdropped
         AND a.attname IN ('active_install_id', 'active_since')) <> 2 THEN
    bad := bad || 'settings columns missing; ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cloud_release_switches w WHERE w.id) THEN
    bad := bad || 'switch row missing; ';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'BACKLOG-4263 S1: post-check failed: %', bad;
  END IF;
END
$post4263s1$;
