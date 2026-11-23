-- /*t:setup*/ COMMITS: user, settings (active I1), deal on I1 and on I2, three messages of I2's deal, one unreferenced
-- blob X dated 3 days back. One DO block, so the replica setting (no auth.users insert trigger writes anywhere else)
-- covers exactly the user insert and cannot leak, whatever the transport does with several statements.
SET LOCAL lock_timeout = '3s';
DO $s$
BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES ('__U__', 'p4263c-__RUN__@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
  SET LOCAL session_replication_role = origin;
  INSERT INTO public.cloud_autosave_settings (user_id, enabled, notice_version, accepted_at, enabled_at, active_install_id, active_since)
  VALUES ('__U__', true, 1, now(), now(), '__I1__', now());
  INSERT INTO public.cloud_deals (owner_user_id, source_install_id, local_transaction_id, content_hash)
  VALUES ('__U__', '__I1__', 'c-__RUN__-1', encode(sha256('d1-__RUN__'::bytea), 'hex')),
         ('__U__', '__I2__', 'c-__RUN__-2', encode(sha256('d2-__RUN__'::bytea), 'hex'));
  INSERT INTO public.cloud_deal_messages (owner_user_id, cloud_deal_id, channel_kind, local_message_id, subject, body_text, content_hash)
  SELECT '__U__', d.id, 'email', 'm-' || n, 'Fixture', 'Fixture', encode(sha256(('m-__RUN__-' || n)::bytea), 'hex')
    FROM public.cloud_deals d, generate_series(1, 3) n WHERE d.owner_user_id = '__U__' AND d.source_install_id = '__I2__';
  INSERT INTO public.cloud_blobs (owner_user_id, sha256, size_bytes, storage_path, created_at, uploaded_at, id)
  SELECT '__U__', encode(sha256('x-__RUN__'::bytea), 'hex'), 10, '__U__/' || g, now() - interval '3 days', now() - interval '3 days', g
    FROM (SELECT gen_random_uuid() AS g) s;
END
$s$;
SELECT (SELECT id FROM public.cloud_blobs WHERE owner_user_id = '__U__') AS x,
       (SELECT id FROM public.cloud_deals WHERE owner_user_id = '__U__' AND source_install_id = '__I1__') AS d1;
