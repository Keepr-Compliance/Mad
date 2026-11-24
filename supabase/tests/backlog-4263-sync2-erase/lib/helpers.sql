-- BACKLOG-4263 sync plan P3 harness helpers. Loaded after the migration, inside the same transaction (which ends in
-- RAISE, so nothing persists). Every id and name is invented and derived from __RUN__ (random per run).
-- Row shapes follow the writers: a removed message row as cloud_tombstone('message') leaves it (subject, body_text,
-- participants NULL; 20261118120000 /*TOMB:scrub*/); a removed file row as cloud_tombstone('file') leaves it
-- (filename NULL, blob_id NULL); a blob row as cloud_register_blob writes it (storage_path = owner/id, M1).

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
  SELECT md5('p4263e:__RUN__:' || n)::uuid
$h$;
CREATE FUNCTION pg_temp.h(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT encode(sha256(convert_to('__RUN__:' || t, 'UTF8')), 'hex')
$h$;

-- Run one SELECT as an API role with that role's claim (own subtransaction). Returns its single value as text, or
-- 'ERR <sqlstate> <message>'. r = '' runs as the session user with an empty role claim.
CREATE FUNCTION pg_temp.call(r text, q text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE j text;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', CASE WHEN r = '' THEN '' ELSE json_build_object('role', r)::text END, true);
    PERFORM set_config('request.jwt.claim.role', r, true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    IF r <> '' THEN EXECUTE format('SET LOCAL ROLE %I', r); END IF;
    EXECUTE q INTO j;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
    RETURN coalesce(j, 'null');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 200);
  END;
END $h$;
CREATE FUNCTION pg_temp.svc(q text) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE t text := pg_temp.call('service_role', q);
BEGIN
  IF t LIKE 'ERR %' THEN RAISE EXCEPTION 'service call failed: % (%)', t, left(q, 120); END IF;
  RETURN t::jsonb;
END $h$;
CREATE FUNCTION pg_temp.claim(dry boolean) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.svc(format('SELECT public.cloud_blob_erase_claim(%L, 1000, 20000)::text', dry))
$h$;
CREATE FUNCTION pg_temp.finish(run uuid, ids uuid[]) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.svc(format('SELECT public.cloud_blob_erase_finish(%L::uuid, %L::uuid[], %L::jsonb, %L)::text', run, ids, '{}', 'ok'))
$h$;
CREATE FUNCTION pg_temp.scrub(run uuid, owner uuid, dry boolean, lim int) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.svc(format('SELECT public.cloud_blob_erase_scrub(%L::uuid, %L::uuid, %L, %s)::text', run, owner, dry, lim))
$h$;

-- fixtures
CREATE FUNCTION pg_temp.mk_user(n int) RETURNS uuid LANGUAGE plpgsql AS $h$
DECLARE u uuid := pg_temp.fx(n);
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (u, 'p4263e-' || substr(md5('__RUN__'), 1, 8) || '-' || n || '@example.test', 'authenticated', 'authenticated',
          '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
  SET LOCAL session_replication_role = origin;
  RETURN u;
END $h$;
CREATE FUNCTION pg_temp.mk_settings(u uuid, active uuid, since timestamptz) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO public.cloud_autosave_settings (user_id, enabled, notice_version, accepted_at, enabled_at, active_install_id, active_since)
  VALUES (u, true, 1, now(), now(), active, since)
  ON CONFLICT (user_id) DO UPDATE SET enabled = true, active_install_id = EXCLUDED.active_install_id, active_since = EXCLUDED.active_since
$h$;
CREATE FUNCTION pg_temp.mk_deal(u uuid, inst uuid, lid text) RETURNS uuid LANGUAGE sql AS $h$
  INSERT INTO public.cloud_deals (owner_user_id, source_install_id, local_transaction_id, content_hash)
  VALUES (u, inst, lid, pg_temp.h('deal:' || lid)) RETURNING id
$h$;
CREATE FUNCTION pg_temp.mk_msg(u uuid, d uuid, lid text, removed timestamptz) RETURNS uuid LANGUAGE sql AS $h$
  INSERT INTO public.cloud_deal_messages (owner_user_id, cloud_deal_id, channel_kind, local_message_id, subject, body_text,
                                          participants, content_hash, removed_at)
  VALUES (u, d, 'email', lid,
          CASE WHEN removed IS NULL THEN 'Fixture subject ' || lid END,
          CASE WHEN removed IS NULL THEN 'Fixture body ' || lid END,
          CASE WHEN removed IS NULL THEN '[{"name":"Fixture"}]'::jsonb END,
          pg_temp.h('msg:' || lid), removed)
  RETURNING id
$h$;
CREATE FUNCTION pg_temp.mk_blob(u uuid, tag text, created timestamptz, uploaded timestamptz, fenced timestamptz) RETURNS uuid LANGUAGE plpgsql AS $h$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.cloud_blobs (id, owner_user_id, sha256, size_bytes, storage_path, created_at, uploaded_at, purge_requested_at)
  VALUES (v, u, pg_temp.h('blob:' || tag), 10, u::text || '/' || v::text, created, uploaded, fenced);
  RETURN v;
END $h$;
CREATE FUNCTION pg_temp.mk_file(u uuid, d uuid, lid text, m uuid, b uuid, removed timestamptz) RETURNS uuid LANGUAGE sql AS $h$
  INSERT INTO public.cloud_deal_files (owner_user_id, cloud_deal_id, local_attachment_id, cloud_message_id, blob_id, filename,
                                       content_hash, removed_at)
  VALUES (u, d, lid, m, CASE WHEN removed IS NULL THEN b END, CASE WHEN removed IS NULL THEN lid || '.pdf' END,
          pg_temp.h('file:' || lid), removed)
  RETURNING id
$h$;
CREATE FUNCTION pg_temp.path(b uuid) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT storage_path FROM public.cloud_blobs WHERE id = b
$h$;
CREATE FUNCTION pg_temp.mk_obj(name text, created timestamptz) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO storage.objects (bucket_id, name, created_at, metadata)
  VALUES ('cloud-deal-files', name, created, jsonb_build_object('size', 10))
$h$;
-- what the Edge Function's Storage API remove does, for the harness (storage.allow_delete_query: Supabase guard on
-- direct deletes from storage tables; a no-op where the guard is not installed)
CREATE FUNCTION pg_temp.rm_obj(n text) RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  PERFORM set_config('storage.allow_delete_query', 'true', true);
  DELETE FROM storage.objects o WHERE o.bucket_id = 'cloud-deal-files' AND o.name = n;
END $h$;
CREATE FUNCTION pg_temp.obj_exists(n text) RETURNS boolean LANGUAGE sql STABLE AS $h$
  SELECT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'cloud-deal-files' AND o.name = n)
$h$;
CREATE FUNCTION pg_temp.switch(v boolean) RETURNS void LANGUAGE plpgsql AS $h$
DECLARE n integer;
BEGIN
  UPDATE public.cloud_release_switches SET one_computer = v;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'cloud_release_switches holds % rows, want 1', n; END IF;
END $h$;
-- The claim's listings are bounded and taken over the whole database: blobs and rowless objects p_limit (1000), oldest
-- first; removed message and file rows p_row_limit (20000), by id; owners to scrub 200, oldest move first. A probe
-- that asserts its own row is listed (or, for c6b, NOT listed) can only tell while the database leaves room; otherwise
-- it says so (PRECONDITION) instead of passing or failing. kind: 'listing' | 'rows' | 'owners'. NULL when there is room.
CREATE FUNCTION pg_temp.room(kind text) RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT CASE
    WHEN kind = 'listing' AND (SELECT count(*) FROM public.cloud_blobs b WHERE NOT EXISTS (SELECT 1 FROM public.cloud_deal_files f WHERE f.blob_id = b.id)) >= 900
      THEN 'PRECONDITION 900 or more unreferenced blobs in the database (the listing holds 1000)'
    WHEN kind = 'listing' AND (SELECT count(*) FROM storage.objects o WHERE o.bucket_id = 'cloud-deal-files' AND o.created_at < now() - interval '24 hours'
            AND NOT EXISTS (SELECT 1 FROM public.cloud_blobs b WHERE b.storage_path = o.name)) >= 900
      THEN 'PRECONDITION 900 or more rowless objects older than 24 h in the database (the listing holds 1000)'
    WHEN kind = 'rows' AND (SELECT count(*) FROM public.cloud_deal_messages m WHERE m.removed_at < now() - interval '24 hours') >= 19000
      THEN 'PRECONDITION 19000 or more message rows removed more than 24 h ago in the database (the batch holds 20000)'
    WHEN kind = 'rows' AND (SELECT count(*) FROM public.cloud_deal_files f WHERE f.removed_at < now() - interval '24 hours') >= 19000
      THEN 'PRECONDITION 19000 or more file rows removed more than 24 h ago in the database (the batch holds 20000)'
    WHEN kind = 'owners' AND (SELECT count(*) FROM public.cloud_autosave_settings s WHERE s.active_install_id IS NOT NULL) >= 190
      THEN 'PRECONDITION 190 or more owners with an active computer in the database (the owners list holds 200)'
  END
$h$;
-- json helpers
CREATE FUNCTION pg_temp.ids(j jsonb) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(array_agg((e ->> 'id')::uuid), '{}') FROM jsonb_array_elements(coalesce(j -> 'blobs', '[]')) e
$h$;
CREATE FUNCTION pg_temp.has_text(j jsonb, k text, v text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $h$
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(j -> k, '[]')) e WHERE e = v)
$h$;
