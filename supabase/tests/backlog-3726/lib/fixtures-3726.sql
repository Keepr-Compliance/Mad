-- BACKLOG-3726 fixtures. Loaded inside each control's transaction, BEFORE the
-- 3726 migration (or a mutant of it). Every id and name is invented.
-- Venue: the backlog-3403 prelude + the applied 3403 and 3725 files (run.sh venue).
SELECT set_config('t3726.asserts', '0', true);
CREATE FUNCTION pg_temp.ok(c boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(c, false) THEN RAISE EXCEPTION 'ASSERT FAILED: %', label; END IF;
  PERFORM set_config('t3726.asserts', (coalesce(nullif(current_setting('t3726.asserts', true), ''), '0')::int + 1)::text, true);
END $$;
CREATE FUNCTION pg_temp.org1() RETURNS uuid LANGUAGE sql AS $$ SELECT '0e372600-0000-4000-8000-0000000000a1'::uuid $$;  -- pii-allow-uuid: invented fixture id
CREATE FUNCTION pg_temp.org2() RETURNS uuid LANGUAGE sql AS $$ SELECT '0e372600-0000-4000-8000-0000000000a2'::uuid $$;  -- pii-allow-uuid: invented fixture id
CREATE FUNCTION pg_temp.agent() RETURNS uuid LANGUAGE sql AS $$ SELECT 'aaaaaaaa-3726-4000-8000-000000000001'::uuid $$;  -- pii-allow-uuid: invented fixture id
CREATE FUNCTION pg_temp.broker() RETURNS uuid LANGUAGE sql AS $$ SELECT 'aaaaaaaa-3726-4000-8000-000000000003'::uuid $$;  -- pii-allow-uuid: invented fixture id
INSERT INTO auth.users (id, email) VALUES (pg_temp.agent(), 'f3726-a@example.test'), (pg_temp.broker(), 'f3726-k@example.test');
INSERT INTO public.organizations (id) VALUES (pg_temp.org1()), (pg_temp.org2());
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  (pg_temp.org1(), pg_temp.agent(), 'agent'), (pg_temp.org1(), pg_temp.broker(), 'broker');

-- A submission of the fixture agent, created p_age ago; abandoned p_abandoned_age ago when given.
CREATE FUNCTION pg_temp.sub(p_status text, p_age interval, p_abandoned_age interval DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, property_address, status, version, created_at, updated_at, abandoned_at)
  VALUES (v, pg_temp.org1(), pg_temp.agent(), 't-' || v, 'Fixture Street', p_status, 1, now() - p_age, now() - p_age,
          CASE WHEN p_abandoned_age IS NULL THEN NULL ELSE now() - p_abandoned_age END);
  RETURN v;
END $$;
CREATE FUNCTION pg_temp.obj(p_name text, p_age interval DEFAULT '0') RETURNS text LANGUAGE sql AS $$
  INSERT INTO storage.objects (bucket_id, name, created_at) VALUES ('submission-attachments', p_name, now() - p_age);
  SELECT p_name;
$$;
-- An attachment row in the submission's own folder plus its object, both written p_age ago.
CREATE FUNCTION pg_temp.att(p_sub uuid, p_file text, p_age interval DEFAULT '0') RETURNS text LANGUAGE plpgsql AS $$
DECLARE p text := pg_temp.org1() || '/' || p_sub || '/' || gen_random_uuid() || '/' || p_file;
BEGIN
  INSERT INTO public.submission_attachments (submission_id, filename, storage_path, created_at) VALUES (p_sub, p_file, p, now() - p_age);
  PERFORM pg_temp.obj(p, p_age);
  RETURN p;
END $$;
-- Storage API stand-in: removes exact names (the real API runs in live/).
CREATE FUNCTION pg_temp.rm(p_paths jsonb) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  PERFORM set_config('storage.allow_delete_query', 'true', true);
  DELETE FROM storage.objects WHERE bucket_id = 'submission-attachments'
     AND name IN (SELECT jsonb_array_elements_text(p_paths));
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('storage.allow_delete_query', 'false', true);
  RETURN n;
END $$;
-- JWT claims for a role; the control then runs SET LOCAL ROLE <role>.
CREATE FUNCTION pg_temp.as_role(p_role text, p_uid uuid DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  SELECT set_config('request.jwt.claim.role', p_role, true);
  SELECT set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
$$;
CREATE FUNCTION pg_temp.ids(r jsonb) RETURNS text[] LANGUAGE sql AS $$
  SELECT coalesce(array_agg(x->>'id' ORDER BY x->>'id'), '{}') FROM jsonb_array_elements(r->'submissions') x $$;
CREATE FUNCTION pg_temp.paths(r jsonb, p_id uuid) RETURNS text[] LANGUAGE sql AS $$
  SELECT coalesce(array_agg(p ORDER BY p), '{}') FROM jsonb_array_elements(r->'submissions') x, jsonb_array_elements_text(x->'paths') p
   WHERE x->>'id' = p_id::text $$;
CREATE FUNCTION pg_temp.allpaths(r jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce(jsonb_agg(p), '[]'::jsonb) FROM jsonb_array_elements(r->'submissions') x, jsonb_array_elements_text(x->'paths') p $$;
-- Calls as service_role (claims + role), back to postgres afterwards.
CREATE FUNCTION pg_temp.claim(p_dry boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.as_role('service_role');
  SET LOCAL ROLE service_role;
  r := public.submission_sweep_claim(p_dry);
  RESET ROLE;
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.finish(r jsonb, p_ids uuid[], p_outcome text DEFAULT 'ok', p_counts jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE f jsonb;
BEGIN
  PERFORM pg_temp.as_role('service_role');
  SET LOCAL ROLE service_role;
  f := public.submission_sweep_finish((r->>'run_id')::uuid, p_ids, p_counts, p_outcome);
  RESET ROLE;
  RETURN f;
END $$;
