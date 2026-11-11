#!/usr/bin/env python3
"""BACKLOG-4236 PR-1 mutations. For each mode: exact-string replace on a migration (or rollback) FILE,
each fragment required to match exactly the stated number of times (else the mode is NOT APPLIED and
counts as a failure), print MUTATION APPLIED + `git diff --numstat` + the changed lines, run the
controls (one call, one transaction ending in RAISE) and the migration-text test, print the reds,
then restore with `git checkout --` and assert the file is clean. Commit before running this.

Usage: mutate.py <mode>[,<mode>...] | all
want 'red'   -> every listed control must turn red (others may too)
want 'green' -> measured equivalent in this venue; kept so the claim stays checked
"""
import json, os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
M1 = 'supabase/migrations/20261112180000_backlog_4236_cloud_autosave_feature_keys.sql'
M2 = 'supabase/migrations/20261112190000_backlog_4236_cloud_autosave_schema.sql'
RB = 'supabase/tests/backlog-4236/rollback-4236.sql'
TRIP = 'broker-portal/__tests__/migrations/cloud-autosave-schema-4236.test.ts'


def drop(marker_line):
    return [(M2, marker_line, '', 1)]


def sub(old, new, cnt=1, f=M2):
    return [(f, old, new, cnt)]


ENT = "  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:%s*/\n    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');\n  END IF;\n"
OWN_CHILD = "   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:%s*/\n"
INST_CHILD = "     AND d.source_install_id = p_source_install_id                                           /*INSTALL:%s*/\n"
ROWS = "IF jsonb_array_length(p_rows) > 500 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:rows:%s*/"
BYTES = "IF octet_length(p_rows::text) > 16777216 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:bytes:%s*/"

MUT = {
  # ---------------------------------------------------------------- grants and catalog
  'G01_license_revoke_keeps_authenticated': (sub('REVOKE ALL ON FUNCTION public._cloud_autosave_license(uuid) FROM PUBLIC, anon, authenticated, service_role;',
      'REVOKE ALL ON FUNCTION public._cloud_autosave_license(uuid) FROM PUBLIC, anon;'), 'A2_function_privileges', 'red'),
  'G02_state_revoke_keeps_public': (sub('REVOKE ALL ON FUNCTION public.get_my_cloud_autosave_state() FROM PUBLIC, anon, authenticated, service_role;',
      'REVOKE ALL ON FUNCTION public.get_my_cloud_autosave_state() FROM anon, authenticated, service_role;'), 'A2_function_privileges', 'red'),
  'G03_assign_granted_to_authenticated': (sub('GRANT EXECUTE ON FUNCTION public.assign_member_addon(uuid, uuid, text, boolean, timestamptz) TO service_role;',
      'GRANT EXECUTE ON FUNCTION public.assign_member_addon(uuid, uuid, text, boolean, timestamptz) TO service_role, authenticated;'), 'A2_function_privileges', 'red'),
  'G04_deals_revoke_keeps_anon': (sub('REVOKE ALL ON TABLE public.cloud_deals FROM PUBLIC, anon, authenticated;',
      'REVOKE ALL ON TABLE public.cloud_deals FROM PUBLIC, authenticated;'), 'A1_table_privileges R1_owner_only_reads', 'red'),
  'G05_blobs_revoke_dropped': (sub('REVOKE ALL ON TABLE public.cloud_blobs FROM PUBLIC, anon, authenticated;\n', ''), 'A1_table_privileges', 'red'),
  'G06_update_granted_on_deals': (sub('GRANT SELECT ON TABLE public.cloud_deals TO authenticated;',
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.cloud_deals TO authenticated;'), 'A1_table_privileges W1_no_direct_writes', 'red'),
  'G07_owner_write_policy': (sub('GRANT SELECT ON TABLE public.cloud_deals TO authenticated;',
      'GRANT SELECT, INSERT ON TABLE public.cloud_deals TO authenticated;\nDROP POLICY IF EXISTS cloud_deals_insert_own ON public.cloud_deals;\nCREATE POLICY cloud_deals_insert_own ON public.cloud_deals FOR INSERT TO authenticated WITH CHECK (owner_user_id = (SELECT auth.uid()));'),
      'W1_no_direct_writes A4_policies_and_publication', 'red'),
  'G08_realtime': (sub('-- ============================================================================ bucket and storage policies',
      'DO $pub$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = \'supabase_realtime\' AND tablename = \'cloud_deals\') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.cloud_deals; END IF; END $pub$;\n-- ============================================================================ bucket and storage policies'),
      'A4_policies_and_publication', 'red'),
  # ---------------------------------------------------------------- read policies
  'R01_org_keyed_read': (sub('/*POL:deals*/', 'OR organization_id IN (SELECT m.organization_id FROM public.organization_members m WHERE m.user_id = (SELECT auth.uid())) /*POL:deals*/'),
      'R1_owner_only_reads', 'red'),
  'R02_staff_read': (sub('/*POL:messages*/', 'OR EXISTS (SELECT 1 FROM public.internal_roles ir WHERE ir.user_id = (SELECT auth.uid())) /*POL:messages*/'),
      'R1_owner_only_reads', 'red'),
  # ---------------------------------------------------------------- storage
  'S01_upload_without_entitlement': (drop('  AND (SELECT public.cloud_autosave_entitled())                                    /*STO:ins:entitled*/\n'), 'P1_storage_insert', 'red'),
  'S02_upload_without_blob': (sub("""  AND EXISTS (SELECT 1 FROM public.cloud_blobs b
               WHERE b.storage_path = objects.name
                 AND b.owner_user_id = (SELECT auth.uid())
                 AND b.uploaded_at IS NULL
                 AND b.purge_requested_at IS NULL)                                 /*STO:ins:blob*/
""", ''), 'P1_storage_insert', 'red'),
  'S03_upload_without_path_pin': (drop("  AND split_part(objects.name, '/', 1) = (SELECT auth.uid())::text                 /*STO:ins:path*/\n"), '', 'green'),
  'S04_read_ignores_fence': (sub("""                 AND b.purge_requested_at IS NULL)                                 /*STO:sel:fence*/""", ')'),
      'P2_storage_read_closed_by_fence SET2_off_unlicensed_deletes_all', 'red'),
  'S05_owner_update_policy': (sub('DROP POLICY IF EXISTS "Cloud deal files: owner reads live blob" ON storage.objects;',
      'DROP POLICY IF EXISTS "Cloud deal files: owner updates" ON storage.objects;\nCREATE POLICY "Cloud deal files: owner updates" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = \'cloud-deal-files\' AND split_part(objects.name, \'/\', 1) = (SELECT auth.uid())::text);\nDROP POLICY IF EXISTS "Cloud deal files: owner reads live blob" ON storage.objects;'),
      'P1_storage_insert A4_policies_and_publication', 'red'),
  # ---------------------------------------------------------------- licence
  'L01_brk_revoked': (drop('     AND a.revoked_at IS NULL                                                      /*BRK:revoked*/\n'), 'E3_revoked', 'red'),
  'L02_brk_ends_at': (drop('     AND (a.ends_at IS NULL OR a.ends_at > now())                                  /*BRK:ends*/\n'), 'E3_ends_at', 'red'),
  'L03_brk_member': (drop('     AND public.member_status_grants_access(m.license_status)                      /*BRK:member*/\n'), 'E3_member_inactive', 'red'),
  'L04_brk_notpersonal': (drop('     AND o.personal_owner_user_id IS NULL                                          /*BRK:notpersonal*/\n'), 'E3_personal_assignment', 'red'),
  'L05_brk_billing': (drop('     AND public.org_billing_service_off(o.id) IS FALSE                             /*BRK:billing*/\n'), 'E3_billing_off', 'red'),
  'L06_brk_plan': (drop("     AND public._org_feature_allowed(o.id, 'cloud_autosave_assignable') IS TRUE   /*BRK:plan*/\n"), 'E3_plan_disallows', 'red'),
  'L07_brk_reads_solo_key': (sub("public._org_feature_allowed(o.id, 'cloud_autosave_assignable') IS TRUE   /*BRK:plan*/",
      "public._org_feature_allowed(o.id, 'cloud_autosave') IS TRUE   /*BRK:plan*/"), 'E0_licensed_paths', 'red'),
  'L08_brk_join_on_id_only': (sub('ON m.id = a.membership_id AND m.organization_id = a.organization_id AND m.user_id = a.user_id  /*BRK:join*/',
      'ON m.id = a.membership_id  /*BRK:join*/'), 'E3_membership_join', 'red'),
  'L09_brk_no_order': (drop('   ORDER BY a.assigned_at, a.organization_id                                       /*BRK:order*/\n'), 'E5_assignment_order', 'red'),
  'L10_solo_no_membership': (sub("""    JOIN public.organization_members m ON m.organization_id = o.id AND m.user_id = p_user_id      /*SOLO:member*/
   WHERE o.personal_owner_user_id = p_user_id
     AND public.member_status_grants_access(m.license_status)                      /*SOLO:active*/
""", """   WHERE o.personal_owner_user_id = p_user_id
"""), 'E1_personal_org_without_membership', 'red'),
  'L11_solo_billing': (drop('     AND public.org_billing_service_off(o.id) IS FALSE                             /*SOLO:billing*/\n'), 'E2_solo_billing_off', 'red'),
  'L12_solo_plan': (drop("     AND public._org_feature_allowed(o.id, 'cloud_autosave') IS TRUE               /*SOLO:plan*/\n"), 'E2_solo_paid_through', 'red'),
  'L13_reasons_all_rows': (sub("""      WHEN bool_and(x.billing_off) FILTER (WHERE x.live) THEN 'billing_off'""", """      WHEN bool_and(x.billing_off) THEN 'billing_off'"""),
      'E4_reason_live_rows_only', 'red'),
  'L14_license_no_caller_check': (sub("""  IF (p_user_id = auth.uid() OR auth.role() = 'service_role' OR auth.role() IS NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  SELECT a.organization_id INTO v_org""", "  SELECT a.organization_id INTO v_org"), 'E7_internal_caller_checks', 'red'),
  'L15_entitled_ignores_enabled': (sub('    SELECT l.licensed AND s.enabled                                                /*ENT:enabled*/', '    SELECT l.licensed                                                /*ENT:enabled*/'),
      'SET3_off_then_upsert', 'red'),
  'L16_entitled_ignores_notice': (sub('           AND s.notice_version = public._cloud_autosave_current_notice_version()  /*ENT:notice*/\n', ''),
      'U1_entitlement_every_write E6_entitled_matches_state', 'red'),
  # ---------------------------------------------------------------- on / off
  'O01_enable_without_licence': (sub("    IF (SELECT l.licensed FROM public._cloud_autosave_license(v_uid) l) IS NOT TRUE THEN      /*SET:licence*/",
      "    IF false THEN      /*SET:licence*/"), 'SET1_enable_gates', 'red'),
  'O02_enable_any_notice': (sub("    IF p_notice_version IS DISTINCT FROM v_cur THEN                                          /*SET:notice*/",
      "    IF false THEN                                          /*SET:notice*/"), 'SET1_enable_gates', 'red'),
  'O03_off_not_one_unit': (sub("""  EXCEPTION WHEN OTHERS THEN                                                                     /*SET:unit*/
    RETURN jsonb_build_object('success', false, 'error', 'turn_off_failed');
  END;""", "  END;"), 'MCP1_failing_disconnect_refuses', 'red'),
  'O04_off_reports_and_succeeds': (sub("""  EXCEPTION WHEN OTHERS THEN                                                                     /*SET:unit*/
    RETURN jsonb_build_object('success', false, 'error', 'turn_off_failed');
  END;""", """  EXCEPTION WHEN OTHERS THEN                                                                     /*SET:unit*/
    NULL;
  END;"""), 'MCP1_failing_disconnect_refuses', 'red'),
  'O05_disconnect_unguarded': (sub("    IF to_regprocedure('public._mcp_disconnect_all_for(uuid,text)') IS NOT NULL THEN            /*SET:mcp*/",
      "    IF true THEN            /*SET:mcp*/"), 'SET2_off_unlicensed_deletes_all', 'red'),
  'O06_off_keeps_rows': (drop('    DELETE FROM public.cloud_deals WHERE owner_user_id = v_uid;                                  /*SET:delete*/\n'), 'SET2_off_unlicensed_deletes_all', 'red'),
  'O07_off_no_fence': (sub("""    UPDATE public.cloud_blobs SET purge_requested_at = now()
     WHERE owner_user_id = v_uid AND purge_requested_at IS NULL;                                 /*SET:fence*/""",
      """    UPDATE public.cloud_blobs SET purge_requested_at = purge_requested_at
     WHERE false;                                 /*SET:fence*/"""), 'SET2_off_unlicensed_deletes_all', 'red'),
  # ---------------------------------------------------------------- deal upsert
  'D01_deal_values_unchecked': (sub("""    ELSE public._cloud_bad_field(p_deal,
           ARRAY['started_at', 'closed_at', 'reviewed_at', 'local_created_at', 'source_updated_at'],
           ARRAY['detection_confidence'], ARRAY['texts_outside_window_count'], ARRAY[]::text[]) END;""", "    ELSE NULL END;"),
      'U7_deal_values', 'red'),
  'D02_org_personal_allowed': (drop('       AND o.personal_owner_user_id IS NULL                                                  /*ORG:notpersonal*/\n'), 'U5_own_personal_org', 'red'),
  'D03_org_inactive_member_allowed': (sub("""       AND public.member_status_grants_access(m.license_status);                             /*ORG:member*/""", ';'), 'U5_deal_organization', 'red'),
  'D04_deal_lookup_ignores_install': (sub('WHERE x.owner_user_id = v_uid AND x.source_install_id = v_inst AND x.local_transaction_id = v_local FOR UPDATE;',
      'WHERE x.owner_user_id = v_uid AND x.local_transaction_id = v_local ORDER BY x.version DESC LIMIT 1 FOR UPDATE;'), 'I1_install_binding', 'red'),
  'D05_confirmed_detection_only': (sub("""      is_confirmed = (v_st IS NULL OR v_st <> 'rejected')
                     AND (v_det IS NULL OR v_det NOT IN ('pending', 'rejected')),               /*DEAL:confirmed*/""",
      """      is_confirmed = (v_det IS NULL OR v_det NOT IN ('pending', 'rejected')),               /*DEAL:confirmed*/"""), 'U8_derived_columns', 'red'),
  'D06_deal_byte_cap_off_by_one': (sub('IF octet_length(p_deal::text) > 1048576 THEN', 'IF octet_length(p_deal::text) > 2097152 THEN'), 'U6_byte_cap', 'red'),
  # ---------------------------------------------------------------- shared row logic
  'W01_same_hash_ignores_tombstone': (sub("    WHEN p_version > 0 AND p_removed_at IS NULL AND p_cur_hash = p_new_hash THEN 'unchanged'      /*ROW:same*/",
      "    WHEN p_version > 0 AND p_cur_hash = p_new_hash THEN 'unchanged'      /*ROW:same*/"), 'T2_same_hash_revives', 'red'),
  'W02_no_same_hash_branch': (sub("    WHEN p_version > 0 AND p_removed_at IS NULL AND p_cur_hash = p_new_hash THEN 'unchanged'      /*ROW:same*/",
      "    WHEN false THEN 'unchanged'      /*ROW:same*/"), 'U3_versions_and_ids U3_child_versions', 'red'),
  'W03_no_compare_and_set': (sub("""    WHEN p_version > 0 AND p_removed_at IS NULL AND p_base IS NOT NULL
         AND p_base IS DISTINCT FROM p_version THEN 'conflict'                                    /*ROW:cas*/""", "    WHEN false THEN 'conflict'"),
      'U3_versions_and_ids U3_child_versions', 'red'),
  'W04_child_write_bumps_deal': (sub('  UPDATE public.cloud_deals SET last_synced_at = now() WHERE id = v_deal;                     /*MSG:touch*/',
      '  UPDATE public.cloud_deals SET last_synced_at = now(), version = version + 1 WHERE id = v_deal;'), 'U4_child_write_keeps_deal_version', 'red'),
  'W05_row_values_unchecked': (sub("""    IF v_bad IS NOT NULL THEN                                                                /*MSG:values*/""",
      "    IF false THEN"), 'U7_row_rejects', 'red'),
  'W06_hidden_optional': (sub("       OR jsonb_typeof(r -> 'hidden_from_export') IS DISTINCT FROM 'boolean'\n", ''), 'U7_structural_refusals', 'red'),
  'W07_link_state_constant': (sub("""                    WHEN r ->> 'match_reason' = 'address_missing' THEN 'needs_review'\n""", ''), 'U8_derived_columns', 'red'),
  'W08_checklist_private_from_flag_only': (sub("    v_private := (r ->> 'template_id') = 'keepr:my-items' OR coalesce((r ->> 'is_private')::boolean, false);   /*CHK:private*/",
      "    v_private := coalesce((r ->> 'is_private')::boolean, false);   /*CHK:private*/"), 'U8_derived_columns', 'red'),
  'W09_no_private_propagation': (sub("""      UPDATE public.cloud_deal_checklist_items SET is_private = v_private
       WHERE cloud_checklist_id = cur.id AND cloud_deal_id = v_deal AND is_private IS DISTINCT FROM v_private;   /*CHK:propagate*/\n""", ''),
      'U8_derived_columns', 'red'),
  'W10_item_private_from_payload': (sub('        is_private = p.is_private,                                                             /*ITEM:private*/',
      "        is_private = coalesce((r ->> 'is_private')::boolean, false),"), 'U8_derived_columns', 'red'),
  'W11_body_cap_off_by_one': (sub('    IF char_length(v_body) > 1000000 THEN v_body := left(v_body, 1000000); v_trunc := true; END IF;   /*MSG:truncate*/',
      '    IF char_length(v_body) >= 1000000 THEN v_body := left(v_body, 1000000); v_trunc := true; END IF;'), 'U9_body_cap', 'red'),
  'W12_no_truncation': (sub('    IF char_length(v_body) > 1000000 THEN v_body := left(v_body, 1000000); v_trunc := true; END IF;   /*MSG:truncate*/', ''), 'U9_body_cap', 'red'),
  'W13_file_attaches_fenced_blob': (drop('         AND b.purge_requested_at IS NULL                                                     /*FILE:unfenced*/\n'), 'B2_fenced_blob_not_attachable', 'red'),
  'W14_file_blob_any_owner': (sub('       WHERE b.owner_user_id = v_uid                                                          /*OWNER:fileblob*/\n', '       WHERE true\n'), 'O1_owner_binding', 'red'),
  'W15_messages_row_cap_off_by_one': (sub(ROWS % 'messages', ROWS.replace('> 500', '>= 500') % 'messages'), 'U6_row_cap', 'red'),
  # ---------------------------------------------------------------- tombstone, delete, blobs
  'T01_tombstone_scrub_kept_body': (sub('             subject = NULL, body_text = NULL, body_truncated = false, participants = NULL          /*TOMB:scrub*/',
      '             body_truncated = false          /*TOMB:scrub*/'), 'T1_tombstone_scrub_unentitled', 'red'),
  'T02_tombstone_owner': (sub('        WHERE t.id = $1 AND t.owner_user_id = $2 /*OWNER:tombstone*/', '        WHERE t.id = $1 AND $2 IS NOT NULL /*OWNER:tombstone*/'), 'O1_owner_binding', 'red'),
  'T03_tombstone_install': (sub('          AND d.source_install_id = $3 /*INSTALL:tombstone*/', '          AND $3 IS NOT NULL /*INSTALL:tombstone*/'), 'I1_install_binding', 'red'),
  'T04_tombstone_cap_off_by_one': (sub('cardinality(p_cloud_ids) > 1000 THEN   /*CAP:tombstone*/', 'cardinality(p_cloud_ids) >= 1000 THEN   /*CAP:tombstone*/'), 'B3_blob_and_tombstone_caps', 'red'),
  'T05_tombstone_needs_entitlement': (sub("  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;\n  EXECUTE format(",
      "  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;\n  IF public.cloud_autosave_entitled() IS NOT TRUE THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;\n  EXECUTE format("),
      'T1_tombstone_scrub_unentitled', 'red'),
  'T06_fence_ignores_references': (sub('     AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_files f WHERE f.blob_id = b.id);       /*FENCE:unreferenced*/', ';'),
      'T3_shared_blob_fencing I2_list_and_delete_install', 'red'),
  'T07_fence_no_caller_check': (sub("""  IF auth.uid() IS DISTINCT FROM p_owner AND auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_owner IS NULL OR p_blob_ids IS NULL""", "  IF p_owner IS NULL OR p_blob_ids IS NULL"), 'E7_internal_caller_checks', 'red'),
  'T08_delete_deal_any_owner': (sub('   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:delete_deal*/',
      '   WHERE d.id = p_cloud_deal_id                                  /*OWNER:delete_deal*/'), 'O1_owner_binding', 'red'),
  'T09_delete_install_any_owner': (sub('     WHERE d.owner_user_id = v_uid                                                  /*OWNER:delete_install*/\n       AND d.source_install_id',
      '     WHERE true\n       AND d.source_install_id'), 'O1_owner_binding', 'red'),
  'T10_delete_install_all_installs': (sub('       AND d.source_install_id = p_source_install_id;                               /*INSTALL:delete_install*/', ';'),
      'I1_install_binding', 'red'),
  'T11_list_installs_any_owner': (sub('              FROM public.cloud_deals d WHERE d.owner_user_id = v_uid                         /*OWNER:list_installs*/',
      '              FROM public.cloud_deals d WHERE true'), 'O1_owner_binding', 'red'),
  'B01_blob_cap_off_by_one': (sub('IF p_size_bytes > 52428800 THEN', 'IF p_size_bytes >= 52428800 THEN'), 'B3_blob_and_tombstone_caps', 'red'),
  'B02_confirm_any_owner': (sub('   WHERE x.id = p_blob_id AND x.owner_user_id = v_uid                                        /*OWNER:confirm*/',
      '   WHERE x.id = p_blob_id                                        /*OWNER:confirm*/'), 'O1_owner_binding', 'red'),
  'B03_confirm_no_object_check': (sub("  IF v_found IS NOT TRUE THEN RETURN jsonb_build_object('ok', false, 'error', 'object_missing'); END IF;   /*CONFIRM:exists*/\n", ''),
      'P3_confirm_states', 'red'),
  'B04_confirm_no_size_check': (sub("  IF v_size IS DISTINCT FROM b.size_bytes::text THEN RETURN jsonb_build_object('ok', false, 'error', 'size_mismatch'); END IF;   /*CONFIRM:size*/\n", ''),
      'P3_confirm_states', 'red'),
  # ---------------------------------------------------------------- assignment
  'M01_assign_any_caller': (sub("  IF auth.role() IS DISTINCT FROM 'service_role' THEN                                      /*ASSIGN:role*/",
      "  IF false THEN                                      /*ASSIGN:role*/"), 'E7_internal_caller_checks', 'red'),
  'M02_assign_inactive_member': (sub('       AND public.member_status_grants_access(m.license_status);                            /*ASSIGN:member*/', ';'), 'M1_assign_inactive_member', 'red'),
  'M03_assign_ignores_plan': (sub("    IF public._org_feature_allowed(p_organization_id, 'cloud_autosave_assignable') IS NOT TRUE THEN   /*ASSIGN:plan*/",
      "    IF false THEN   /*ASSIGN:plan*/"), 'M1_assign_plan', 'red'),
  # ---------------------------------------------------------------- M1 and rollback
  'K01_key_on_somewhere': (sub("SELECT p.id, fd.id, false, 'false'", "SELECT p.id, fd.id, p.tier = 'enterprise', 'false'", f=M1), 'F1_feature_keys', 'red'),
  'K02_key_with_tier': (sub("'sync', 'boolean', 'false', NULL, 165, false)", "'sync', 'boolean', 'false', 'team', 165, false)", f=M1), 'F1_feature_keys', 'red'),
  'RB01_rollback_keeps_a_function': (sub('DROP FUNCTION IF EXISTS public.cloud_list_installs();\n', '', f=RB), 'G1_rollback_then_apply', 'red'),
}
for k in ['parties', 'checklists', 'items', 'messages', 'files']:
    MUT['U_entitled_%s' % k] = (sub(ENT % k, ''), 'U1_entitlement_every_write', 'red')
    MUT['U_owner_%s' % k] = (sub(OWN_CHILD % k, '   WHERE d.id = p_cloud_deal_id\n'), 'O1_owner_binding', 'red')
    MUT['U_install_%s' % k] = (sub(INST_CHILD % k, ''), 'I1_install_binding', 'red')
    MUT['U_rows_%s' % k] = (sub(ROWS % k, ''), 'U6_row_cap', 'red')
    MUT['U_bytes_%s' % k] = (sub(BYTES % k, ''), 'U6_byte_cap', 'red')
for k in ['deal', 'register', 'mark_synced']:
    MUT['U_entitled_%s' % k] = (sub(ENT % k, ''), 'U1_entitlement_every_write', 'red')
MUT['U_owner_mark_synced'] = (sub('   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:mark_synced*/',
                                  '   WHERE d.id = p_cloud_deal_id'), 'O1_owner_binding', 'red')
MUT['U_install_mark_synced'] = (sub('     AND d.source_install_id = p_source_install_id                                           /*INSTALL:mark_synced*/\n', ''), 'I1_install_binding', 'red')
MUT['U_bytes_deal'] = (sub("  IF octet_length(p_deal::text) > 1048576 THEN                                               /*CAP:bytes:deal*/\n    RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large');\n  END IF;\n", ''), 'U6_byte_cap', 'red')


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)


def run_controls():
    out = subprocess.run([os.path.join(here, 'run.sh')], capture_output=True, text=True)
    o = out.stdout
    try:
        return json.loads(o[o.index('{'):o.rindex('}') + 1]), o
    except Exception:
        return None, o + out.stderr


def run_trip():
    out = subprocess.run(['npx', 'jest', '--config', 'broker-portal/jest.config.js', TRIP], capture_output=True, text=True, cwd=root)
    tail = [l for l in (out.stdout + out.stderr).splitlines() if l.startswith('Tests:')]
    return out.returncode, (tail[-1] if tail else 'Tests: ?')


if sh('git', 'status', '--porcelain', '--', M1, M2, RB).stdout.strip():
    sys.exit('migration/rollback have uncommitted changes; commit before mutating')

modes = list(MUT) if sys.argv[1] == 'all' else sys.argv[1].split(',')
missed = 0
for mode in modes:
    edits, targets, want = MUT[mode]
    files = sorted({f for f, *_ in edits})
    try:
        applied = True
        for fn, old, new, cnt in edits:
            path = os.path.join(root, fn)
            body = open(path).read()
            n = body.count(old)
            if n != cnt:
                print('== %s\nMUTATION NOT APPLIED: fragment matched %d times (expected %d)' % (mode, n, cnt))
                applied = False
                break
            open(path, 'w').write(body.replace(old, new))
        if not applied:
            missed += 1
            continue
        ns = sh('git', 'diff', '--numstat', '--', *files).stdout.strip()
        if not ns:
            print('== %s\nMUTATION NOT APPLIED: git diff empty' % mode)
            missed += 1
            continue
        changed = [l for l in sh('git', 'diff', '-U0', '--', *files).stdout.splitlines()
                   if l[:1] in '+-' and not l.startswith(('+++', '---'))]
        print('== %s (want %s: %s)' % (mode, want, targets or '-'))
        print('MUTATION APPLIED numstat=%s' % ' '.join(x.split('\t')[0] + '/' + x.split('\t')[1] for x in ns.splitlines()))
        for l in changed[:6]:
            print('  %s %s' % (l[0], l[1:].strip()[:160]))
        d, raw = run_controls()
        if d is None:
            print('NO RESULT ' + raw[:400].replace('\n', ' '))
            reds = {'__no_result__'}
            print('RESULT none')
        else:
            reds = set(d.get('real_reds', []))
            print('RESULT total=%s pass=%s real_fail=%s reds=%s' % (d['total'], d['pass'], d['real_fail'], ','.join(sorted(reds))))
            if not d['total']:
                print('ZERO CONTROLS RAN')
        rc, tline = run_trip()
        print('TRIPWIRE exit=%d %s' % (rc, tline))
        tgt = set(targets.split()) if targets else set()
        if want == 'red':
            hit = tgt <= reds and d is not None and d.get('total')
            print('VERDICT %s' % ('RED as wanted' if hit else 'STAYED GREEN (missed: %s)' % ','.join(sorted(tgt - reds))))
            if not hit:
                missed += 1
        else:
            print('VERDICT %s' % ('green as measured' if not reds else 'RED (was expected equivalent): %s' % ','.join(sorted(reds))))
    finally:
        sh('git', 'checkout', '--', *files)
        st = sh('git', 'status', '--porcelain', '--', *files).stdout.strip()
        print('RESTORED clean=%s' % (st == ''))
        if st:
            sys.exit('restore failed')
print('MISSED %d of %d' % (missed, len(modes)))
sys.exit(1 if missed else 0)
