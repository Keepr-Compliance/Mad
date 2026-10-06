-- BACKLOG-3474 helpers for the save_checklist_template controls (c26-c36).
--
-- Loaded by run.sh inside EVERY control's transaction, after lib/fixtures.sql
-- and migration 20260924190429 (save_checklist_template), before any mutant.
-- Rolled back with the control. Reuses fixtures.sql's act_as / act_owner /
-- check / id helpers and its organizations and users.
--
-- The stale-check token. Every template made here carries this updated_at, so
-- a save in the same transaction (where now() is constant) still moves it.
-- The text is TRANSCRIBED, not invented: production's `to_json(updated_at)`
-- for a real checklist_templates row, read 2026-09-24 (pm_comments 6501344d),
-- which is the serialiser PostgREST uses for a timestamptz column.
SELECT set_config('t3474.token0', '2026-09-24T18:57:37.552806+00:00', true) IS NOT NULL AS t3474_ready;

-- template(org, name, n): owner INSERT of a template with n items
-- ('<name> item <k>', required when k is odd, sort_order k*10) and
-- updated_at = token0. Returns its id.
CREATE FUNCTION pg_temp.t3474_template(p_org uuid, p_name text, p_items integer) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
BEGIN
  INSERT INTO public.checklist_templates (organization_id, name, sort_order, created_at, updated_at)
  VALUES (p_org, p_name, 900,
          current_setting('t3474.token0')::timestamptz, current_setting('t3474.token0')::timestamptz)
  RETURNING checklist_templates.id INTO v;
  INSERT INTO public.checklist_template_items (template_id, title, is_required, sort_order)
  SELECT v, p_name || ' item ' || g, g % 2 = 1, g * 10 FROM generate_series(1, p_items) AS g;
  RETURN v;
END
$$;

-- items(tpl): the template's items as a save payload, in display order.
CREATE FUNCTION pg_temp.t3474_items(p_tpl uuid) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id, 'title', i.title, 'description', i.description,
           'is_required', i.is_required, 'expected_document_type', i.expected_document_type)
         ORDER BY i.sort_order, i.id), '[]'::jsonb)
    FROM public.checklist_template_items i
   WHERE i.template_id = p_tpl
$$;

-- item(tpl, k): the k-th item (1-based, display order) as a payload element.
CREATE FUNCTION pg_temp.t3474_item(p_tpl uuid, p_k integer) RETURNS jsonb
LANGUAGE sql AS $$ SELECT pg_temp.t3474_items(p_tpl) -> (p_k - 1) $$;

-- shape(tpl): 'title:required:type:sort|...' in display order.
CREATE FUNCTION pg_temp.t3474_shape(p_tpl uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT coalesce(string_agg(format('%s:%s:%s:%s', i.title, i.is_required::text,
                                    coalesce(i.expected_document_type, '-'), i.sort_order),
                             '|' ORDER BY i.sort_order, i.id), '')
    FROM public.checklist_template_items i
   WHERE i.template_id = p_tpl
$$;

-- head(tpl): 'name|description|updated_at' of the template row, for "unchanged" checks.
CREATE FUNCTION pg_temp.t3474_head(p_tpl uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT t.name || '|' || coalesce(t.description, '-') || '|' || (to_json(t.updated_at) #>> '{}')
    FROM public.checklist_templates t WHERE t.id = p_tpl
$$;

-- token(tpl): the template's updated_at as PostgREST serialises it.
CREATE FUNCTION pg_temp.t3474_token(p_tpl uuid) RETURNS text
LANGUAGE sql AS $$ SELECT to_json(t.updated_at) #>> '{}' FROM public.checklist_templates t WHERE t.id = p_tpl $$;

-- save(uid, org, tpl, token, name, description, items): calls the function AS
-- uid (role authenticated + JWT claims, the PostgREST request shape).
-- 'ok:<id>|<updated_at>' or '<SQLSTATE>:<message>'. An error rolls back only
-- the call's subtransaction, as a failed PostgREST request rolls back its own.
CREATE FUNCTION pg_temp.t3474_save(p_uid uuid, p_org uuid, p_tpl uuid, p_token text,
                                   p_name text, p_desc text, p_items jsonb) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  r   record;
  res text;
BEGIN
  PERFORM pg_temp.act_as(p_uid);
  BEGIN
    SELECT * INTO r FROM public.save_checklist_template(p_org, p_tpl, p_token, p_name, p_desc, p_items);
    res := 'ok:' || coalesce(r.id::text, '') || '|' || coalesce(r.updated_at, '');
  EXCEPTION WHEN OTHERS THEN
    res := SQLSTATE || ':' || SQLERRM;
  END;
  PERFORM pg_temp.act_owner();
  RETURN res;
END
$$;

-- tok(result): the updated_at part of an 'ok:' result.
CREATE FUNCTION pg_temp.t3474_tok(p_res text) RETURNS text
LANGUAGE sql AS $$ SELECT split_part(p_res, '|', 2) $$;

SELECT 'fixtures-3474 loaded' AS fixtures_3474;
