#!/usr/bin/env python3
"""BACKLOG-4192 DB controls. Venue: keepr-test ONLY (~/.claude/bin/kt-sql). Nothing persists:
every run is ONE DO block that ends in RAISE 'P4192_RESULT {...}', which rolls back the fixtures
and any mutation.

Fixtures (shape transcribed from production pm_backlog_items / pm_projects: only the NOT NULL
columns without defaults are set): one pm_projects row 'P4192 project', one pm_backlog_items row
'P4192 item' with status 'testing' in that project. Callers: an existing internal_roles user
(internal), a random uuid with no internal role (norole), service_role, anon.

Usage: controls.py <mode> [<mode> ...]
  modes: base                 run every check, no mutation
         M_revoke_service     REVOKE EXECUTE on both functions FROM service_role (D3 control)
         M_grant_anon         GRANT EXECUTE on both functions TO anon (D3 control)
Prints the parsed result per mode.
"""
import json, os, re, subprocess, sys

MUT = {
    'base': '',
    'M_revoke_service': """
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.pm_update_item_status(uuid, text) FROM service_role';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.pm_get_board_tasks(uuid, uuid, text) FROM service_role';
    IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.pm_update_item_status(uuid,text)'::regprocedure) LIKE '%service_role%'
      THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;
    v_res := v_res || jsonb_build_object('mutation', 'MUTATION APPLIED revoke service_role');""",
    'M_grant_anon': """
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.pm_update_item_status(uuid, text) TO anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.pm_get_board_tasks(uuid, uuid, text) TO anon';
    IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.pm_update_item_status(uuid,text)'::regprocedure) NOT LIKE '%anon=X%'
      THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;
    v_res := v_res || jsonb_build_object('mutation', 'MUTATION APPLIED grant anon');""",
}

TEMPLATE = r"""
DO $drv$
DECLARE
  v_res jsonb := '{}'::jsonb;
  v_internal uuid;
  v_norole uuid := gen_random_uuid();
  v_proj uuid;
  v_item uuid;
  v_out jsonb;
  v_state text; v_msg text;
BEGIN
  SELECT user_id INTO v_internal FROM internal_roles LIMIT 1;
  IF v_internal IS NULL THEN RAISE EXCEPTION 'fixture: no internal_roles row'; END IF;
  INSERT INTO pm_projects (name) VALUES ('P4192 project') RETURNING id INTO v_proj;
  INSERT INTO pm_backlog_items (title, status, project_id) VALUES ('P4192 item', 'testing', v_proj) RETURNING id INTO v_item;
  v_res := v_res || jsonb_build_object('acl_update', (SELECT proacl::text FROM pg_proc WHERE oid = 'public.pm_update_item_status(uuid,text)'::regprocedure),
                                       'acl_board', (SELECT proacl::text FROM pg_proc WHERE oid = 'public.pm_get_board_tasks(uuid,uuid,text)'::regprocedure));
  __MUT__

  EXECUTE $f$CREATE FUNCTION pg_temp.as_caller(who text, uid uuid) RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    EXECUTE 'RESET ROLE';
    IF who = 'anon' THEN
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claim.role', 'anon', true);
      EXECUTE 'SET LOCAL ROLE anon';
    ELSIF who = 'service_role' THEN
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      EXECUTE 'SET LOCAL ROLE service_role';
    ELSE
      PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', uid::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      EXECUTE 'SET LOCAL ROLE authenticated';
    END IF;
  END $b$$f$;

  -- each check: reset the item to 'testing' as postgres, switch caller, call, record outcome
  DECLARE
    v_checks text[][] := ARRAY[
      ['upd_internal', 'internal', 'update'],
      ['board_internal', 'internal', 'board'],
      ['upd_norole', 'norole', 'update'],
      ['board_norole', 'norole', 'board'],
      ['upd_service', 'service_role', 'update'],
      ['board_service', 'service_role', 'board'],
      ['upd_anon', 'anon', 'update'],
      ['board_anon', 'anon', 'board']
    ];
    i int;
    v_who text; v_what text; v_name text;
  BEGIN
    FOR i IN 1 .. array_length(v_checks, 1) LOOP
      v_name := v_checks[i][1]; v_who := v_checks[i][2]; v_what := v_checks[i][3];
      EXECUTE 'RESET ROLE';
      UPDATE pm_backlog_items SET status = CASE WHEN v_what = 'board' THEN 'pending_uat' ELSE 'testing' END WHERE id = v_item;
      BEGIN
        PERFORM pg_temp.as_caller(v_who, CASE WHEN v_who = 'internal' THEN v_internal ELSE v_norole END);
        IF v_what = 'update' THEN
          v_out := public.pm_update_item_status(v_item, 'pending_uat');
          EXECUTE 'RESET ROLE';
          v_out := v_out || jsonb_build_object('row_status', (SELECT status FROM pm_backlog_items WHERE id = v_item));
        ELSE
          v_out := public.pm_get_board_tasks(NULL, v_proj, NULL);
          EXECUTE 'RESET ROLE';
          v_out := jsonb_build_object(
            'has_key', v_out ? 'pending_uat',
            'keys', (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(v_out) k),
            'pending_uat_count', jsonb_array_length(COALESCE(v_out->'pending_uat', '[]'::jsonb)),
            'item_in_pending_uat', COALESCE(v_out->'pending_uat', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', v_item)),
            'total', (SELECT sum(jsonb_array_length(value)) FROM jsonb_each(v_out)));
        END IF;
        v_res := v_res || jsonb_build_object(v_name, jsonb_build_object('ok', true, 'out', v_out));
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_res := v_res || jsonb_build_object(v_name, jsonb_build_object('ok', false, 'sqlstate', v_state, 'msg', v_msg));
      END;
    END LOOP;
  END;
  EXECUTE 'RESET ROLE';
  RAISE EXCEPTION 'P4192_RESULT %', v_res::text;
END $drv$;
"""


def run(mode):
    sql = TEMPLATE.replace('__MUT__', MUT[mode])
    p = subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), '-c', sql], capture_output=True, text=True)
    blob = p.stdout + p.stderr
    try:
        msg = json.loads(p.stdout.strip().splitlines()[0])['message']
    except Exception:
        msg = blob
    k = msg.find('P4192_RESULT ')
    if k < 0:
        print(mode, 'NO RESULT:', blob[:2000])
        return None
    return json.JSONDecoder().raw_decode(msg[k + len('P4192_RESULT '):])[0]


if __name__ == '__main__':
    for mode in sys.argv[1:]:
        r = run(mode)
        print(f'=== {mode}')
        print(json.dumps(r, indent=1))
