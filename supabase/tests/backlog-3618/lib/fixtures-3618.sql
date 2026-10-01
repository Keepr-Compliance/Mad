-- BACKLOG-3618 fixtures: helpers only, no rows. Loaded after the 3607 file and
-- before the 3618 file.

-- prod3618(): lib/fp-3618.sql as read from production (read-only), 2026-09-30,
-- before the 3618 file. Control e00 proves the venue's prelude equals it;
-- control e13 proves the rollback returns to it.
CREATE FUNCTION pg_temp.prod3618() RETURNS TABLE (k text, v text)
LANGUAGE sql AS $$
  VALUES
    ('column_grants', 'c0a4f0eb793ad53dcafcc9b26f4cc77a'),
    ('columns', '44e7349527c21bf0352ed7ecda049aa7'),
    ('constraints', '5a13345e77571a13d49333c63548f1fc'),
    ('fn:add_submission_checklist_at_review(uuid,uuid)', '42fbc9657bdf4226cad82748d57e3acc def=true cfg=search_path="" acl={postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('fn:can_edit_checklist_templates(uuid)', 'f6a29733517b1bb7e82197ff15eece8e def=true cfg=search_path=public acl={postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('fn:save_checklist_template(uuid,uuid,text,text,text,jsonb)', '2f12452735acff624cb6287cae68bddb def=false cfg=search_path=public acl={postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('fn:snapshot_submission_checklists(uuid,jsonb)', '029af8d2b14ebed58b760552c116d133 def=false cfg=search_path="" acl={postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('indexes', 'checklist_templates_org_seed_key_key,checklist_templates_org_sort_idx,checklist_templates_pkey'),
    ('policies', '0e932f1779e9bd6d1b420d34d35132f8')
$$;

-- fp_diff(a, b): every key whose value differs, 'k: a -> b', or '' when equal.
CREATE FUNCTION pg_temp.fp_diff(a text, b text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  EXECUTE format($q$
    SELECT COALESCE(string_agg(COALESCE(x.k, y.k) || ': ' || COALESCE(x.v, '<absent>') || ' -> ' || COALESCE(y.v, '<absent>'), '; '
                               ORDER BY COALESCE(x.k, y.k)), '')
      FROM (%s) x(k, v) FULL JOIN (%s) y(k, v) ON x.k = y.k
     WHERE x.v IS DISTINCT FROM y.v$q$, a, b) INTO r;
  RETURN r;
END
$$;

-- tpl3618(org key, owner, name, include): one template with one item, written
-- as the connecting role. Returns the template id.
CREATE FUNCTION pg_temp.tpl3618(p_org text, p_owner uuid, p_name text, p_include boolean DEFAULT true) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  INSERT INTO public.checklist_templates (organization_id, owner_user_id, name, include_in_submission)
  VALUES (pg_temp.id(p_org), p_owner, p_name, p_include) RETURNING id INTO v;
  INSERT INTO public.checklist_template_items (template_id, title) VALUES (v, p_name || ' item');
  RETURN v;
END
$$;

-- one_cl(template id, name): a one-item payload entry for the snapshot RPC.
CREATE FUNCTION pg_temp.one_cl(p_tpl uuid, p_name text, p_sort integer DEFAULT 0) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('template_id', p_tpl::text, 'template_name', p_name, 'sort_order', p_sort,
           'items', jsonb_build_array(jsonb_build_object('title', p_name || ' item', 'local_item_id', 'L-' || p_name,
                                                          'is_required', true, 'sort_order', 10)));
$$;
