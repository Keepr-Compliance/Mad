-- ============================================================================
-- Migration: cloud_list_install_rows (BACKLOG-4243 PR-3)
--
-- One read function for the desktop's daily reconcile: one page of the caller's
-- own online rows of one kind, saved from one install. The desktop never reads
-- the cloud_* tables directly.
--
--   cloud_list_install_rows(p_expected_user_id, p_source_install_id, p_kind, p_after, p_limit)
--   -> { ok: true, rows: [{cloud_id, cloud_deal_id, local_id, content_hash, removed}], next_after }
--   -> { ok: false, error: not_authorized | wrong_account | invalid_input }
--
--   p_kind: deal | party | checklist | checklist_item. Rows ordered by id, after p_after,
--   at most p_limit (1..1000). next_after is the last id when the page is full, else null.
--   Every row: owner = auth.uid() and its deal saved from p_source_install_id.
--
-- Creates one function and alters nothing else. STABLE, SECURITY DEFINER, search_path ''.
-- Grants: EXECUTE revoked from PUBLIC, anon, authenticated and service_role, then granted to
-- authenticated only. Rollback: supabase/tests/backlog-4243/rollback-20261114130000.sql.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cloud_list_install_rows(
  p_expected_user_id uuid, p_source_install_id uuid, p_kind text, p_after uuid, p_limit integer
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_uid uuid := auth.uid(); v_limit integer; v_tab text; v_local text; v_deal text; v_removed text;
        v_rows jsonb; v_n integer; v_last uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authorized'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:list_rows*/
  IF p_source_install_id IS NULL OR p_kind IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  SELECT k.tab, k.local_col, k.deal_col, k.removed_expr INTO v_tab, v_local, v_deal, v_removed
    FROM (VALUES
      ('deal',           'cloud_deals',                'local_transaction_id', 't.id',            'false'),
      ('party',          'cloud_deal_parties',         'local_party_id',       't.cloud_deal_id', 't.removed_at IS NOT NULL'),
      ('checklist',      'cloud_deal_checklists',      'local_checklist_id',   't.cloud_deal_id', 't.removed_at IS NOT NULL'),
      ('checklist_item', 'cloud_deal_checklist_items', 'local_item_id',        't.cloud_deal_id', 't.removed_at IS NOT NULL')
    ) k(kind, tab, local_col, deal_col, removed_expr)
   WHERE k.kind = p_kind;
  IF v_tab IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  v_limit := least(greatest(coalesce(p_limit, 1000), 1), 1000);                               /*CAP:list_rows*/
  EXECUTE format(
    'SELECT coalesce(jsonb_agg(jsonb_build_object(''cloud_id'', x.id, ''cloud_deal_id'', x.deal_id, ''local_id'', x.local_id,
                                                   ''content_hash'', x.content_hash, ''removed'', x.removed) ORDER BY x.id), ''[]''::jsonb),
            count(*)::integer, (array_agg(x.id ORDER BY x.id DESC))[1]
       FROM (SELECT t.id, %s AS deal_id, t.%I AS local_id, t.content_hash, (%s) AS removed
               FROM public.%I t JOIN public.cloud_deals d ON d.id = %s
              WHERE t.owner_user_id = $1 AND d.owner_user_id = $1 /*OWNER:list_rows*/
                AND d.source_install_id = $2 /*INSTALL:list_rows*/
                AND ($3 IS NULL OR t.id > $3)
              ORDER BY t.id LIMIT $4) x',
    v_deal, v_local, v_removed, v_tab, v_deal)
    INTO v_rows, v_n, v_last USING v_uid, p_source_install_id, p_after, v_limit;
  RETURN jsonb_build_object('ok', true, 'rows', v_rows,
                            'next_after', CASE WHEN v_n = v_limit THEN v_last END);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_list_install_rows(uuid, uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_list_install_rows(uuid, uuid, text, uuid, integer) TO authenticated;
