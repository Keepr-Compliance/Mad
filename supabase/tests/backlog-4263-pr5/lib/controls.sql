-- BACKLOG-4263 PR-5 harness: controls, loaded AFTER the migration. Each control is a function returning
-- 'PASS' or 'FAIL: ...'; pg_temp.iso runs one and rolls it back, so controls never see each other's writes.
-- Wrapper calls run as the anon role with the claims PostgREST sets (shape 1 unless a control says otherwise).

-- connections granted after the migration (the CHECK admits 'mcp:todos' only now)
DO $fx5b$
BEGIN
  PERFORM pg_temp.conn('KA_todos', pg_temp.id('A'), 11, 'mcp:todos', 'anthropic', 'Fixture Evil Name');
  PERFORM pg_temp.conn('KB_todos', pg_temp.id('B'), 12, 'mcp:todos', 'openai');
  PERFORM pg_temp.conn('KA_exp', pg_temp.id('A'), 13, 'mcp:todos', 'openai');
  PERFORM pg_temp.conn('KA_todos2', pg_temp.id('A'), 14, 'mcp:todos', 'openai');
  -- owner B: one removed item (B's own desktop removal) and one purged item (purged_at, as the purge sets it)
  PERFORM pg_temp.push(pg_temp.id('B'), pg_temp.id('IB'), pg_temp.nowt(), jsonb_build_array(pg_temp.op('remove', 'item', pg_temp.id('b2'))));
  UPDATE public.cloud_deal_checklist_items SET purged_at = now() WHERE id = pg_temp.id('b3');
  UPDATE public.mcp_tokens SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
   WHERE connection_id = pg_temp.id('KA_exp') AND kind = 'access';
END
$fx5b$;

CREATE FUNCTION pg_temp.iso(fn text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE v text;
BEGIN
  BEGIN
    EXECUTE format('SELECT pg_temp.%I()', fn) INTO v;
    RAISE EXCEPTION USING ERRCODE = 'MX001';
  EXCEPTION
    WHEN SQLSTATE 'MX001' THEN NULL;
    WHEN OTHERS THEN v := 'FAIL: ERR ' || SQLSTATE || ' ' || left(SQLERRM, 300);
  END;
  RETURN v;
END $h$;

CREATE FUNCTION pg_temp.sw(on_ boolean) RETURNS void LANGUAGE sql AS $h$ UPDATE public.mcp_write_settings SET writes_enabled = on_ WHERE id $h$;
CREATE FUNCTION pg_temp.unrate() RETURNS void LANGUAGE sql AS $h$
  DELETE FROM public.mcp_rate_counters WHERE bucket IN (
    SELECT 'call_conn:' || v FROM pg_temp.p5_fx WHERE k LIKE 'K%'
    UNION ALL SELECT 'call_user:' || v FROM pg_temp.p5_fx WHERE k IN ('A', 'B')
    UNION ALL SELECT 'todo_write_user:' || v FROM pg_temp.p5_fx WHERE k IN ('A', 'B'))
$h$;

-- claims as PostgREST might leave them: 1 = request.jwt.claims only; 2 = all three; 3 = none
CREATE FUNCTION pg_temp.shape(s int) RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN s IN (1, 2) THEN '{"role":"anon"}' ELSE '' END, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', CASE WHEN s = 2 THEN 'anon' ELSE '' END, true);
END $h$;
CREATE FUNCTION pg_temp.claims_now() RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT jsonb_build_object('claims', coalesce(current_setting('request.jwt.claims', true), ''),
    'sub', coalesce(current_setting('request.jwt.claim.sub', true), ''), 'role', coalesce(current_setting('request.jwt.claim.role', true), ''),
    'auth_role', auth.role(), 'auth_uid', auth.uid(), 'lock_timeout', current_setting('lock_timeout'))
$h$;
-- one wrapper call as anon: {res, before, after} (claims read in the same transaction, as anon, right after the call)
CREATE FUNCTION pg_temp.wp(q text, s int DEFAULT 1) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE r jsonb; b jsonb; a jsonb;
BEGIN
  PERFORM pg_temp.shape(s);
  EXECUTE 'SET LOCAL ROLE anon';
  b := pg_temp.claims_now();
  BEGIN
    EXECUTE q INTO r;
  EXCEPTION WHEN OTHERS THEN r := jsonb_build_object('sqlerr', SQLSTATE, 'msg', left(SQLERRM, 200));
  END;
  a := pg_temp.claims_now();
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.clear_claims();
  RETURN jsonb_build_object('res', r, 'before', b, 'after', a);
END $h$;
CREATE FUNCTION pg_temp.w(q text) RETURNS jsonb LANGUAGE sql AS $h$ SELECT pg_temp.wp(q, 1) -> 'res' $h$;
CREATE FUNCTION pg_temp.ws(r jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(r -> 'result' ->> 'status', 'E:' || (r ->> 'error'), 'X:' || coalesce(r::text, 'null'))
$h$;
CREATE FUNCTION pg_temp.q_upd(n int, item uuid, ch jsonb, req text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT format('SELECT public.mcp_update_todo(%L, %L::bytea, %L, %L, %L::jsonb, %L)', pg_temp.secret(), pg_temp.dgl(n), pg_temp.res(), item, ch, req)
$h$;
CREATE FUNCTION pg_temp.q_add(n int, dl uuid, title text, note text DEFAULT NULL, due text DEFAULT NULL, req text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT format('SELECT public.mcp_add_todo(%L, %L::bytea, %L, %L, %L, %L, %L, %L)', pg_temp.secret(), pg_temp.dgl(n), pg_temp.res(), dl, title, note, due, req)
$h$;
CREATE FUNCTION pg_temp.q_rm(n int, item uuid, req text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT format('SELECT public.mcp_remove_todo(%L, %L::bytea, %L, %L, %L)', pg_temp.secret(), pg_temp.dgl(n), pg_temp.res(), item, req)
$h$;
CREATE FUNCTION pg_temp.q_rs(n int, item uuid, req text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT format('SELECT public.mcp_restore_todo(%L, %L::bytea, %L, %L, %L)', pg_temp.secret(), pg_temp.dgl(n), pg_temp.res(), item, req)
$h$;
CREATE FUNCTION pg_temp.q_wa(n int, sec text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT format('SELECT public.mcp_write_access(%L, %L::bytea, %L)', coalesce(sec, pg_temp.secret()), pg_temp.dgl(n), pg_temp.res())
$h$;
CREATE FUNCTION pg_temp.q_cl(n int, dl uuid) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT format('SELECT public.mcp_get_deal_checklists(%L, %L::bytea, %L, %L, false, NULL)', pg_temp.secret(), pg_temp.dgl(n), pg_temp.res(), dl)
$h$;
CREATE FUNCTION pg_temp.logs(conn uuid) RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT coalesce(jsonb_agg(jsonb_build_object('tool', l.tool, 'outcome', l.outcome, 'rows', l.rows_returned) ORDER BY l.id), '[]')
    FROM public.mcp_call_log l WHERE l.connection_id = conn
$h$;
-- the state a write must not change: every part rev and value of the owner's items, and the history count
CREATE FUNCTION pg_temp.state(u uuid) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT md5(coalesce((SELECT string_agg(concat_ws('|', t.id, t.is_checked, t.title, t.note, t.due_date, t.removed_at, t.done_rev, t.title_rev,
            t.note_rev, t.due_rev, t.removed_rev, t.sort_order), ',' ORDER BY t.id) FROM public.cloud_deal_checklist_items t WHERE t.owner_user_id = u), '')
       || (SELECT count(*) FROM public.cloud_todo_history h WHERE h.owner_user_id = u)::text
       || (SELECT count(*) FROM public.cloud_deal_checklist_items t WHERE t.owner_user_id = u)::text)
$h$;

-- ---------------------------------------------------------------- rule 3: the switch is off by default; off = no write
CREATE FUNCTION pg_temp.c_switch_default() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); s0 text; r jsonb; wa jsonb; cl jsonb; ra jsonb; rm jsonb; rs jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  s0 := pg_temp.state(A);
  r := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m1'), '{"done":true}'));
  ra := pg_temp.w(pg_temp.q_add(11, pg_temp.id('DA1'), 'x'));
  rm := pg_temp.w(pg_temp.q_rm(11, pg_temp.id('m1')));
  rs := pg_temp.w(pg_temp.q_rs(11, pg_temp.id('m4')));
  wa := pg_temp.w(pg_temp.q_wa(11));
  cl := pg_temp.w(pg_temp.q_cl(11, pg_temp.id('DA1')));
  RETURN pg_temp.all_of(
    pg_temp.pass((SELECT writes_enabled FROM public.mcp_write_settings WHERE id) IS FALSE, 'switch not off'),
    pg_temp.pass(pg_temp.ws(r) = 'E:read_only', 'upd ' || r::text),
    pg_temp.pass(pg_temp.ws(ra) = 'E:read_only', 'add'),
    pg_temp.pass(pg_temp.ws(rm) = 'E:read_only', 'rm'),
    pg_temp.pass(pg_temp.ws(rs) = 'E:read_only', 'rs'),
    pg_temp.pass(pg_temp.state(A) = s0, 'state changed'),
    pg_temp.pass(wa = '{"ok":true,"write":false}'::jsonb, 'write_access ' || wa::text),
    pg_temp.pass((cl -> 'result' -> 'v')::int = 1, 'frame ' || left(cl::text, 200)),
    pg_temp.pass(pg_temp.logs(pg_temp.id('KA_todos')) @> '[{"tool":"update_todo","outcome":"read_only","rows":0}]', 'log ' || pg_temp.logs(pg_temp.id('KA_todos'))::text));
END $c$;

-- ---------------------------------------------------------------- rule 1: an old read-only grant gains nothing
CREATE FUNCTION pg_temp.c_old_grant() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); s0 text; r jsonb; wa jsonb; rf jsonb; r2 jsonb; ra jsonb; rm jsonb; rs jsonb; rc jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  PERFORM pg_temp.sw(true);
  s0 := pg_temp.state(A);
  r := pg_temp.w(pg_temp.q_upd(1, pg_temp.id('m1'), '{"done":true}'));
  ra := pg_temp.w(pg_temp.q_add(1, pg_temp.id('DA1'), 'x'));
  rm := pg_temp.w(pg_temp.q_rm(1, pg_temp.id('m1')));
  rs := pg_temp.w(pg_temp.q_rs(1, pg_temp.id('m4')));
  wa := pg_temp.w(pg_temp.q_wa(1));
  -- a refresh of the read grant (new access token digest 21): the scope answered and kept is mcp:read
  rf := pg_temp.w(format('SELECT public.mcp_refresh(%L, %L::bytea, %L, %L, %L::bytea, %L::bytea)', pg_temp.secret(), pg_temp.dgl(501),
          pg_temp.client(), pg_temp.res(), pg_temp.dgl(21), pg_temp.dgl(521)));
  r2 := pg_temp.w(pg_temp.q_upd(21, pg_temp.id('m1'), '{"done":true}'));
  rc := pg_temp.w(pg_temp.q_cl(1, pg_temp.id('DA1')));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(r) = 'E:read_only', 'old grant upd ' || r::text),
    pg_temp.pass(pg_temp.ws(ra) = 'E:read_only', 'add'),
    pg_temp.pass(pg_temp.ws(rm) = 'E:read_only', 'rm'),
    pg_temp.pass(pg_temp.ws(rs) = 'E:read_only', 'rs'),
    pg_temp.pass(wa = '{"ok":true,"write":false}'::jsonb, 'write_access ' || wa::text),
    pg_temp.pass(rf ->> 'scope' = 'mcp:read' AND rf ->> 'ok' = 'true', 'refresh ' || rf::text),
    pg_temp.pass((SELECT scope FROM public.mcp_connections WHERE id = pg_temp.id('KA_read')) = 'mcp:read', 'scope after refresh'),
    pg_temp.pass(pg_temp.ws(r2) = 'E:read_only', 'after refresh ' || r2::text),
    pg_temp.pass(pg_temp.state(A) = s0, 'state changed'),
    -- every connection made before the migration still reads
    pg_temp.pass(rc -> 'result' ->> 'kind' = 'keepr.get_deal_checklists', 'read still works'));
END $c$;

-- ---------------------------------------------------------------- consent: the scope granted follows the switch, never upgraded
-- steps: 'v' = view (keeps the latest nonce), 'on' / 'off' = the switch; then approve with the latest nonce, exchange
-- (token digest dn), and the write access of that token
CREATE FUNCTION pg_temp.consent_steps(k text, ask text, steps text[], dn int, old_nonce boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); ver text := 'v' || md5(k) || md5(k || 'x'); bind bytea := sha256(convert_to('p5-bind-' || k, 'UTF8'));
        cd bytea := sha256(convert_to('p5-code-' || k, 'UTF8')); b jsonb; v jsonb; first_nonce text; views jsonb := '[]'; ap jsonb; ex jsonb; wa jsonb;
        rid text; sc text; st text;
BEGIN
  b := pg_temp.w(format('SELECT public.mcp_authorize_begin(%L, %L, %L, %L, %L, %L, %L, NULL, %L::bytea, %L::bytea)', pg_temp.secret(), pg_temp.client(),
         'https://claude.ai/api/mcp/auth_callback', public._mcp_b64url(sha256(convert_to(ver, 'UTF8'))), 'S256', pg_temp.res(), ask,
         '\x' || encode(bind, 'hex'), '\x' || encode(sha256(convert_to('p5-ip-' || k, 'UTF8')), 'hex')));
  rid := b ->> 'request_id';
  IF rid IS NULL THEN RETURN jsonb_build_object('begin', b); END IF;
  FOREACH st IN ARRAY steps LOOP
    IF st = 'on' THEN PERFORM pg_temp.sw(true);
    ELSIF st = 'off' THEN PERFORM pg_temp.sw(false);
    ELSE
      v := pg_temp.rpc(A, format('SELECT public.mcp_authorize_view(%L, %L::bytea)', rid, '\x' || encode(bind, 'hex')));
      first_nonce := coalesce(first_nonce, v ->> 'nonce');
      views := views || jsonb_build_array(v -> 'scope');
    END IF;
  END LOOP;
  ap := pg_temp.rpc(A, format('SELECT public.mcp_authorize_approve(%L, %L::bytea, %L, %L::bytea)', rid, '\x' || encode(bind, 'hex'),
          CASE WHEN old_nonce THEN first_nonce ELSE v ->> 'nonce' END, '\x' || encode(cd, 'hex')));
  SELECT c.scope INTO sc FROM public.mcp_authorization_codes x JOIN public.mcp_connections c ON c.id = x.connection_id WHERE x.code_sha256 = sha256(cd);
  ex := pg_temp.w(format('SELECT public.mcp_exchange_code(%L, %L::bytea, %L, %L, %L, %L, %L::bytea, %L::bytea)', pg_temp.secret(), '\x' || encode(cd, 'hex'),
          ver, pg_temp.client(), 'https://claude.ai/api/mcp/auth_callback', pg_temp.res(), pg_temp.dgl(dn), pg_temp.dgl(dn + 500)));
  wa := pg_temp.w(pg_temp.q_wa(dn));
  RETURN jsonb_build_object('views', views, 'approve', coalesce(ap ->> 'error', ap ->> 'ok'), 'granted', sc, 'token_scope', ex -> 'scope', 'write_access', wa -> 'write');
END $c$;
CREATE FUNCTION pg_temp.consent(k text, ask text, flip_before_view boolean, flip_to boolean) RETURNS jsonb LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); ver text := 'v' || md5(k) || md5(k || 'x'); bind bytea := sha256(convert_to('p5-bind-' || k, 'UTF8'));
        cd bytea := sha256(convert_to('p5-code-' || k, 'UTF8')); b jsonb; v jsonb; ap jsonb; ex jsonb; rid text; sc text; reqsc text;
BEGIN
  b := pg_temp.w(format('SELECT public.mcp_authorize_begin(%L, %L, %L, %L, %L, %L, %L, NULL, %L::bytea, %L::bytea)', pg_temp.secret(), pg_temp.client(),
         'https://claude.ai/api/mcp/auth_callback', public._mcp_b64url(sha256(convert_to(ver, 'UTF8'))), 'S256', pg_temp.res(), ask,
         '\x' || encode(bind, 'hex'), '\x' || encode(sha256(convert_to('p5-ip-' || k, 'UTF8')), 'hex')));
  rid := b ->> 'request_id';
  IF rid IS NULL THEN RETURN jsonb_build_object('begin', b); END IF;
  SELECT scope INTO reqsc FROM public.mcp_authorization_requests WHERE id = rid;
  IF flip_before_view THEN PERFORM pg_temp.sw(flip_to); END IF;
  v := pg_temp.rpc(A, format('SELECT public.mcp_authorize_view(%L, %L::bytea)', rid, '\x' || encode(bind, 'hex')));
  ap := pg_temp.rpc(A, format('SELECT public.mcp_authorize_approve(%L, %L::bytea, %L, %L::bytea)', rid, '\x' || encode(bind, 'hex'), v ->> 'nonce', '\x' || encode(cd, 'hex')));
  SELECT c.scope INTO sc FROM public.mcp_authorization_codes x JOIN public.mcp_connections c ON c.id = x.connection_id WHERE x.code_sha256 = sha256(cd);
  ex := pg_temp.w(format('SELECT public.mcp_exchange_code(%L, %L::bytea, %L, %L, %L, %L, %L::bytea, %L::bytea)', pg_temp.secret(), '\x' || encode(cd, 'hex'),
          ver, pg_temp.client(), 'https://claude.ai/api/mcp/auth_callback', pg_temp.res(), pg_temp.dgl(31), pg_temp.dgl(531)));
  RETURN jsonb_build_object('begin_ok', b -> 'ok', 'request_scope', reqsc, 'view_scope', v -> 'scope', 'approve_ok', ap -> 'ok',
                            'granted', sc, 'token_scope', ex -> 'scope', 'exchange_ok', ex -> 'ok');
END $c$;
CREATE FUNCTION pg_temp.c_consent() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE off_ jsonb; on_ jsonb; on_off jsonb; off_on jsonb; ask_todos jsonb; bad jsonb; on_read jsonb; f1 jsonb; f2 jsonb; f3 jsonb; f4 jsonb; f5 jsonb; f6 jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  PERFORM pg_temp.sw(false);
  off_ := pg_temp.consent('off', 'mcp:read', false, false);
  ask_todos := pg_temp.consent('ask_todos_off', 'mcp:todos', false, false);
  off_on := pg_temp.consent('off_then_on', 'mcp:todos', true, true);
  bad := pg_temp.w(format('SELECT public.mcp_authorize_begin(%L, %L, %L, %L, %L, %L, %L, NULL, %L::bytea, %L::bytea)', pg_temp.secret(), pg_temp.client(),
         'https://claude.ai/api/mcp/auth_callback', public._mcp_b64url(sha256(convert_to('v' || md5('bad') || md5('bad2'), 'UTF8'))), 'S256', pg_temp.res(),
         'mcp:read mcp:write', '\x' || encode(sha256(convert_to('b-bad', 'UTF8')), 'hex'), '\x' || encode(sha256(convert_to('ip-bad', 'UTF8')), 'hex')));
  PERFORM pg_temp.sw(true);
  on_ := pg_temp.consent('on', 'mcp:todos', false, false);
  on_read := pg_temp.consent('on_read', 'mcp:read', false, false);
  on_off := pg_temp.consent('on_then_off', 'mcp:todos', true, false);
  -- the page's scope is what approve grants at most (reviewer R1): flips between view and approve, both ways
  PERFORM pg_temp.sw(true);
  f1 := pg_temp.consent_steps('flip_off_on', 'mcp:todos', ARRAY['off', 'v', 'on'], 51);
  PERFORM pg_temp.sw(true);
  f2 := pg_temp.consent_steps('flip_on_off', 'mcp:todos', ARRAY['v', 'off'], 52);
  PERFORM pg_temp.sw(true);
  f3 := pg_temp.consent_steps('views_down_up', 'mcp:todos', ARRAY['v', 'off', 'v', 'on', 'v'], 53);
  PERFORM pg_temp.sw(true);
  f4 := pg_temp.consent_steps('old_page', 'mcp:todos', ARRAY['v', 'off', 'v', 'on'], 54, true);
  PERFORM pg_temp.sw(false);
  f5 := pg_temp.consent_steps('asked_write_while_off', 'mcp:todos', ARRAY['v'], 55);
  PERFORM pg_temp.sw(true);
  f6 := pg_temp.consent_steps('write_on', 'mcp:todos', ARRAY['v'], 56);
  RETURN pg_temp.all_of(
    pg_temp.pass(f1 = '{"views":["mcp:read"],"approve":"true","granted":"mcp:read","token_scope":"mcp:read","write_access":false}'::jsonb, 'read page, switch on at approve ' || f1::text),
    pg_temp.pass(f2 = '{"views":["mcp:todos"],"approve":"true","granted":"mcp:read","token_scope":"mcp:read","write_access":false}'::jsonb, 'write page, switch off at approve ' || f2::text),
    pg_temp.pass(f3 = '{"views":["mcp:todos","mcp:read","mcp:read"],"approve":"true","granted":"mcp:read","token_scope":"mcp:read","write_access":false}'::jsonb, 'a read page is never followed by a write page ' || f3::text),
    pg_temp.pass(f4 ->> 'approve' = 'request_invalid' AND f4 -> 'granted' = 'null'::jsonb, 'an earlier page cannot be approved ' || f4::text),
    pg_temp.pass(f5 = '{"views":["mcp:read"],"approve":"true","granted":"mcp:read","token_scope":"mcp:read","write_access":false}'::jsonb, 'write asked while off: read grant, read page, no write tools ' || f5::text),
    pg_temp.pass(f6 = '{"views":["mcp:todos"],"approve":"true","granted":"mcp:todos","token_scope":"mcp:todos","write_access":true}'::jsonb, 'write page, switch on ' || f6::text),
    pg_temp.pass(off_ ->> 'request_scope' = 'mcp:read' AND off_ ->> 'view_scope' = 'mcp:read' AND off_ ->> 'granted' = 'mcp:read' AND off_ ->> 'token_scope' = 'mcp:read', 'off ' || off_::text),
    pg_temp.pass(ask_todos ->> 'granted' = 'mcp:read' AND ask_todos ->> 'view_scope' = 'mcp:read', 'asked todos while off ' || ask_todos::text),
    pg_temp.pass(off_on ->> 'request_scope' = 'mcp:read' AND off_on ->> 'view_scope' = 'mcp:read' AND off_on ->> 'granted' = 'mcp:read', 'write asked while off, approved on ' || off_on::text),
    pg_temp.pass(on_read ->> 'request_scope' = 'mcp:read' AND on_read ->> 'view_scope' = 'mcp:read' AND on_read ->> 'granted' = 'mcp:read'
                 AND on_read ->> 'token_scope' = 'mcp:read', 'read asked while on ' || on_read::text),
    pg_temp.pass(bad ->> 'error' = 'invalid_scope', 'wider scope ' || bad::text),
    pg_temp.pass(on_ ->> 'request_scope' = 'mcp:todos' AND on_ ->> 'view_scope' = 'mcp:todos' AND on_ ->> 'granted' = 'mcp:todos'
                 AND on_ ->> 'token_scope' = 'mcp:todos' AND on_ ->> 'exchange_ok' = 'true', 'on ' || on_::text),
    pg_temp.pass(on_off ->> 'view_scope' = 'mcp:read' AND on_off ->> 'granted' = 'mcp:read' AND on_off ->> 'token_scope' = 'mcp:read', 'begun on, approved off ' || on_off::text));
END $c$;

-- ---------------------------------------------------------------- a write: actor, history, call log, item out (Q5: a required template item may be ticked)
CREATE FUNCTION pg_temp.c_write_ok() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); t uuid := pg_temp.id('t1'); r jsonb; h record; K uuid := pg_temp.id('KA_todos'); h0 bigint; lg jsonb;
        u1 jsonb; u1c boolean; f4 jsonb; f4i public.cloud_deal_checklist_items; f4j public.cloud_deal_checklist_items; cd jsonb; cdd date; un jsonb; ob jsonb; obl text; m uuid := pg_temp.id('m1');
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  h0 := pg_temp.head(A);
  r := pg_temp.w(pg_temp.q_upd(11, t, '{"done":true}'));
  SELECT * INTO h FROM public.cloud_todo_history x WHERE x.entity_id = t ORDER BY x.id DESC LIMIT 1;
  lg := pg_temp.logs(K);
  f4i := pg_temp.it(t);
  u1 := pg_temp.w(pg_temp.q_upd(11, t, '{"done":false}'));
  u1c := (pg_temp.it(t)).is_checked;
  f4 := pg_temp.w(pg_temp.q_upd(11, m, '{"done":true,"title":"Call the lender today","note":"ask about rate","due_date":"2026-12-01"}'));
  f4j := pg_temp.it(m);
  cd := pg_temp.w(pg_temp.q_upd(11, m, '{"due_date":null}'));
  cdd := (pg_temp.it(m)).due_date;
  un := pg_temp.w(pg_temp.q_upd(11, m, '{"note":"ask about rate"}'));
  ob := pg_temp.w(pg_temp.q_upd(12, pg_temp.id('b1'), '{"done":true}'));
  obl := (SELECT actor_label FROM public.cloud_todo_history x WHERE x.entity_id = pg_temp.id('b1') ORDER BY x.id DESC LIMIT 1);
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(r) = 'applied', 'status ' || r::text),
    pg_temp.pass(f4i.is_checked IS TRUE AND f4i.checked_at IS NOT NULL AND f4i.is_required, 'item'),
    pg_temp.pass(f4i.done_by = 'ai_app:' || K::text, 'done_by ' || coalesce(f4i.done_by, 'null')),
    pg_temp.pass(true, ''),
    pg_temp.pass(h.actor_kind = 'ai_app' AND h.actor_ref = K::text AND h.actor_label = 'Claude' AND h.outcome = 'applied' AND h.part = 'done', 'history ' || row_to_json(h)::text),
    pg_temp.pass(pg_temp.head(A) > h0 AND (pg_temp.it(t)).change_seq > h0, 'numbered for the pull'),
    pg_temp.pass(r -> 'result' -> 'item' ->> 'item_id' = t::text AND (r -> 'result' -> 'item' -> 'done')::boolean
                 AND (r -> 'result' -> 'item' -> 'editable_title')::boolean IS FALSE AND (r -> 'result' -> 'item' -> 'removable')::boolean IS FALSE
                 AND r -> 'result' ->> 'kind' = 'keepr.todo_change' AND (r -> 'result' -> 'v')::int = 1, 'item out ' || r::text),
    pg_temp.pass(lg = '[{"tool":"update_todo","outcome":"ok","rows":1}]', 'log ' || lg::text),
    -- un-tick (Q5)
    pg_temp.pass(pg_temp.ws(u1) = 'applied' AND u1c IS FALSE, 'untick ' || u1::text),
    -- every part in one call: one transaction, every part applied
    pg_temp.pass(pg_temp.ws(f4) = 'applied' AND f4j.title = 'Call the lender today' AND f4j.note = 'ask about rate'
                 AND f4j.due_date = DATE '2026-12-01' AND f4j.is_checked, 'four parts ' || f4::text),
    pg_temp.pass(pg_temp.ws(cd) = 'applied' AND cdd IS NULL, 'clear due ' || cd::text),
    -- the same value again: unchanged
    pg_temp.pass(pg_temp.ws(un) = 'unchanged', 'unchanged ' || un::text),
    -- an openai connection is labelled ChatGPT
    pg_temp.pass(pg_temp.ws(ob) = 'applied' AND obl = 'ChatGPT', 'openai label ' || ob::text || coalesce(obl, 'null')));
END $c$;

-- ---------------------------------------------------------------- Q1: no rename or removal of a template item; no AI restore of one
CREATE FUNCTION pg_temp.c_template() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); s0 text; r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  s0 := pg_temp.state(A);
  r1 := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('t1'), '{"title":"Renamed"}'));
  r2 := pg_temp.w(pg_temp.q_rm(11, pg_temp.id('t1')));
  r3 := pg_temp.w(pg_temp.q_rs(11, pg_temp.id('t2')));
  r4 := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m2'), '{"title":"Order the keys"}'));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(r1) = 'not_allowed' AND r1 -> 'result' -> 'item' ->> 'title' = 'Inspection report', 'rename template ' || r1::text),
    pg_temp.pass(pg_temp.ws(r2) = 'not_allowed', 'remove template ' || r2::text),
    pg_temp.pass(pg_temp.ws(r3) = 'not_allowed' AND (pg_temp.it(pg_temp.id('t2'))).removed_at IS NOT NULL, 'restore template ' || r3::text),
    pg_temp.pass(pg_temp.ws(r4) = 'applied' AND (pg_temp.it(pg_temp.id('m2'))).title = 'Order the keys', 'rename my item ' || r4::text),
    pg_temp.pass((pg_temp.it(pg_temp.id('t1'))).title = 'Inspection report' AND (pg_temp.it(pg_temp.id('t1'))).removed_at IS NULL, 'template item untouched'));
END $c$;

-- ---------------------------------------------------------------- one call is all or nothing
CREATE FUNCTION pg_temp.c_all_or_nothing() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); s0 text; r jsonb; h0 bigint; s1 text; lg jsonb; bd jsonb; s2 text;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  s0 := pg_temp.state(A); h0 := pg_temp.head(A);
  r := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('t1'), '{"done":true,"title":"Renamed"}'));
  s1 := pg_temp.state(A); lg := pg_temp.logs(pg_temp.id('KA_todos'));
  bd := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m1'), '{"done":true,"due_date":"1999-01-01"}'));
  s2 := pg_temp.state(A);
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(r) = 'not_allowed', 'status ' || r::text),
    pg_temp.pass((pg_temp.it(pg_temp.id('t1'))).is_checked IS NOT TRUE, 'done part kept'),
    pg_temp.pass(s1 = s0 AND pg_temp.head(A) = h0, 'something written'),
    pg_temp.pass((r -> 'result' -> 'item' -> 'done')::boolean IS NOT TRUE, 'item out shows the write'),
    pg_temp.pass(lg = '[{"tool":"update_todo","outcome":"refused","rows":0}]', 'log ' || lg::text),
    -- a bad value in one part: invalid_input, nothing written
    pg_temp.pass(pg_temp.ws(bd) = 'E:invalid_input' AND s2 = s0, 'bad due date ' || bd::text));
END $c$;

-- ---------------------------------------------------------------- a locked deal takes no AI change (lock_reason, a submission); uploading is not locked
CREATE FUNCTION pg_temp.c_lock() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); s0 text; r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; r5 jsonb; r6 jsonb;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  s0 := pg_temp.state(A);
  r1 := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('l1'), '{"done":true}'));
  r2 := pg_temp.w(pg_temp.q_add(11, pg_temp.id('DA3'), 'Added while locked'));
  r3 := pg_temp.w(pg_temp.q_rm(11, pg_temp.id('l1')));
  r4 := pg_temp.w(pg_temp.q_rs(11, pg_temp.id('l2')));
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status, version)
  VALUES (pg_temp.id('O'), A, 'da6', 'Fixture da6 Way', 'uploading', 1);
  SET LOCAL session_replication_role = origin;
  r5 := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('s1'), '{"note":"during upload"}'));
  SET LOCAL session_replication_role = replica;
  UPDATE public.transaction_submissions SET status = 'submitted' WHERE submitted_by = A AND local_transaction_id = 'da6';
  SET LOCAL session_replication_role = origin;
  r6 := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('s1'), '{"note":"after submit"}'));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(r1) = 'locked', 'upd ' || r1::text),
    pg_temp.pass(pg_temp.ws(r2) = 'locked', 'add ' || r2::text),
    pg_temp.pass(pg_temp.ws(r3) = 'locked', 'rm ' || r3::text),
    pg_temp.pass(pg_temp.ws(r4) = 'locked', 'rs ' || r4::text),
    pg_temp.pass(pg_temp.ws(r5) = 'applied', 'uploading ' || r5::text),
    pg_temp.pass(pg_temp.ws(r6) = 'locked' AND (pg_temp.it(pg_temp.id('s1'))).note = 'during upload', 'submitted ' || r6::text));
END $c$;

-- ---------------------------------------------------------------- removed: refused with a pointer to restore; restore of My items; a removed deal
CREATE FUNCTION pg_temp.c_removed() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; r5 jsonb; r6 jsonb; r7 jsonb; r8 jsonb;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  r1 := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m4'), '{"note":"edit a removed one"}'));
  r2 := pg_temp.w(pg_temp.q_rs(11, pg_temp.id('m4')));
  r3 := pg_temp.w(pg_temp.q_rs(11, pg_temp.id('m4')));
  r4 := pg_temp.w(pg_temp.q_rm(11, pg_temp.id('m2')));
  r5 := pg_temp.w(pg_temp.q_rm(11, pg_temp.id('m2')));
  r6 := pg_temp.w(pg_temp.q_add(11, pg_temp.id('DA5'), 'On a removed deal'));
  r7 := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('r1'), '{"done":true}'));
  UPDATE public.cloud_deal_checklist_items SET purged_at = now() WHERE id = pg_temp.id('m2');
  r8 := pg_temp.w(pg_temp.q_rs(11, pg_temp.id('m2')));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(r1) = 'is_removed' AND (pg_temp.it(pg_temp.id('m4'))).note IS NULL AND (r1 -> 'result' -> 'item' -> 'removed')::boolean, 'edit removed ' || r1::text),
    pg_temp.pass(pg_temp.ws(r2) = 'restored' AND (pg_temp.it(pg_temp.id('m4'))).removed_at IS NULL AND (r2 -> 'result' -> 'item' -> 'removed')::boolean IS FALSE, 'restore ' || r2::text),
    pg_temp.pass(pg_temp.ws(r3) = 'not_removed', 'restore again ' || r3::text),
    pg_temp.pass(pg_temp.ws(r4) = 'removed' AND (pg_temp.it(pg_temp.id('m2'))).removed_at IS NOT NULL AND (pg_temp.it(pg_temp.id('m2'))).removed_by = 'ai_app:' || pg_temp.id('KA_todos')::text, 'remove ' || r4::text),
    pg_temp.pass(pg_temp.ws(r5) = 'already_removed', 'remove again ' || r5::text),
    pg_temp.pass(pg_temp.ws(r6) = 'is_removed', 'add to removed deal ' || r6::text),
    pg_temp.pass(pg_temp.ws(r7) = 'is_removed', 'edit on removed deal ' || r7::text),
    pg_temp.pass(pg_temp.ws(r8) = 'not_restorable' AND r8 -> 'result' -> 'item' = 'null'::jsonb, 'purged ' || r8::text),
    pg_temp.pass(pg_temp.ws(pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m2'), '{"done":true}'))) = 'E:not_found', 'purged edit'));
END $c$;

-- ---------------------------------------------------------------- what the readers hide is not writable; another owner's ids are not found
CREATE FUNCTION pg_temp.c_cross_owner() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE B uuid := pg_temp.id('B'); A uuid := pg_temp.id('A'); sb text; r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; r5 jsonb; r6 jsonb;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  sb := pg_temp.state(B);
  r1 := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('b1'), '{"done":true}'));
  r2 := pg_temp.w(pg_temp.q_add(11, pg_temp.id('DB1'), 'Into B'));
  r3 := pg_temp.w(pg_temp.q_rm(11, pg_temp.id('b1')));
  r4 := pg_temp.w(pg_temp.q_upd(11, md5('nothing')::uuid, '{"done":true}'));
  r5 := pg_temp.w(pg_temp.q_add(11, pg_temp.id('DA4'), 'Unconfirmed'));
  r6 := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('n1'), '{"done":true}'));
  RETURN pg_temp.all_of(
    pg_temp.pass(r1 = '{"ok":false,"error":"not_found"}'::jsonb AND r1 = r4, 'other owner item ' || r1::text || ' vs ' || r4::text),
    pg_temp.pass(r2 = '{"ok":false,"error":"not_found"}'::jsonb, 'other owner deal ' || r2::text),
    pg_temp.pass(r3 = '{"ok":false,"error":"not_found"}'::jsonb, 'other owner remove ' || r3::text),
    pg_temp.pass(pg_temp.state(B) = sb, 'B changed'),
    pg_temp.pass(public._mcp_todo_item_out(A, pg_temp.id('b1')) IS NULL AND public._mcp_todo_item_out(B, pg_temp.id('b1')) IS NOT NULL, 'item out owner'),
    pg_temp.pass(r5 = '{"ok":false,"error":"not_found"}'::jsonb, 'unconfirmed deal add ' || r5::text),
    pg_temp.pass(r6 = '{"ok":false,"error":"not_found"}'::jsonb, 'unconfirmed deal edit ' || r6::text),
    pg_temp.pass(public._mcp_todo_item_out(A, pg_temp.id('n1')) IS NULL, 'item out unconfirmed'));
END $c$;

-- ---------------------------------------------------------------- a retried call: request_id replays through the ledger; without it the values decide
CREATE FUNCTION pg_temp.c_replay() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); m uuid := pg_temp.id('m1'); r1 jsonb; r2 jsonb; r3 jsonb; a1 jsonb; a2 jsonb; a3 jsonb; hn bigint; h0 bigint; n0 bigint;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  r1 := pg_temp.w(pg_temp.q_upd(11, m, '{"note":"first"}', 'req-1'));
  hn := pg_temp.hist_n(m); h0 := pg_temp.head(A);
  r2 := pg_temp.w(pg_temp.q_upd(11, m, '{"note":"first"}', 'req-1'));
  hn := pg_temp.hist_n(m) - hn; h0 := pg_temp.head(A) - h0;
  r3 := pg_temp.w(pg_temp.q_upd(11, m, '{"note":"second"}', 'req-1'));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(r1) = 'applied' AND pg_temp.ws(r2) = 'applied', 'statuses ' || r1::text || r2::text),
    pg_temp.pass(hn = 0 AND h0 = 0, 'replay wrote: hist +' || hn || ' head +' || h0),
    -- the same request_id with other arguments is a new change
    pg_temp.pass(pg_temp.ws(r3) = 'applied' AND (pg_temp.it(m)).note = 'second', 'new args ' || r3::text));
END $c$;
-- a request_id is a retry key of one connection and one tool only (reviewer C-R4, C-R5)
CREATE FUNCTION pg_temp.c_replay_scope() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); m uuid := pg_temp.id('m1'); m2 uuid := pg_temp.id('m2'); r1 jsonb; r2 jsonb; l0 bigint; l1 bigint; l2 bigint; t1 jsonb; t2 jsonb; rm2 timestamptz;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  l0 := (SELECT count(*) FROM public.cloud_todo_ops WHERE owner_user_id = A);
  r1 := pg_temp.w(pg_temp.q_upd(11, m, '{"note":"xconn"}', 'same-key'));
  l1 := (SELECT count(*) FROM public.cloud_todo_ops WHERE owner_user_id = A);
  r2 := pg_temp.w(pg_temp.q_upd(14, m, '{"note":"xconn"}', 'same-key'));
  l2 := (SELECT count(*) FROM public.cloud_todo_ops WHERE owner_user_id = A);
  t1 := pg_temp.w(pg_temp.q_rm(11, m2, 'same-tool-key'));
  t2 := pg_temp.w(pg_temp.q_rs(11, m2, 'same-tool-key'));
  rm2 := (pg_temp.it(m2)).removed_at;
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(r1) = 'applied' AND pg_temp.ws(r2) = 'unchanged' AND l1 = l0 + 1 AND l2 = l1 + 1,
      'another connection, same key ' || jsonb_build_object('r1', pg_temp.ws(r1), 'r2', pg_temp.ws(r2), 'ledger', jsonb_build_array(l0, l1, l2))::text),
    pg_temp.pass(pg_temp.ws(t1) = 'removed' AND pg_temp.ws(t2) = 'restored' AND rm2 IS NULL, 'another tool, same key ' || pg_temp.ws(t1) || '/' || pg_temp.ws(t2)));
END $c$;

-- another owner's ids (live, removed, purged), an unconfirmed deal's and a random id: one identical answer, every tool
CREATE FUNCTION pg_temp.c_enum() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x uuid := md5('p5-nothing')::uuid; a jsonb; id_ uuid; k text; nf jsonb := '{"ok":false,"error":"not_found"}'; sb text;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  sb := pg_temp.state(pg_temp.id('B'));
  a := jsonb_build_object('add_B', pg_temp.w(pg_temp.q_add(11, pg_temp.id('DB1'), 'x')), 'add_x', pg_temp.w(pg_temp.q_add(11, x, 'x')),
                          'add_unconfirmed', pg_temp.w(pg_temp.q_add(11, pg_temp.id('DA4'), 'x')));
  FOREACH k IN ARRAY ARRAY['b1', 'b2', 'b3', 'x', 'n1'] LOOP
    id_ := CASE WHEN k = 'x' THEN x ELSE pg_temp.id(k) END;
    PERFORM pg_temp.unrate();
    a := a || jsonb_build_object('upd_' || k, pg_temp.w(pg_temp.q_upd(11, id_, '{"note":"x"}')),
                                 'rm_' || k, pg_temp.w(pg_temp.q_rm(11, id_)), 'rs_' || k, pg_temp.w(pg_temp.q_rs(11, id_)));
  END LOOP;
  RETURN pg_temp.all_of(
    pg_temp.pass((SELECT count(*) FROM jsonb_each(a) WHERE value <> nf) = 0 AND (SELECT count(*) FROM jsonb_each(a)) = 18,
      (SELECT jsonb_object_agg(key, value::text) FROM jsonb_each(a) WHERE value <> nf)::text),
    pg_temp.pass(pg_temp.state(pg_temp.id('B')) = sb, 'B changed'));
END $c$;

CREATE FUNCTION pg_temp.c_replay_add() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); a1 jsonb; a2 jsonb; a3 jsonb; n0 bigint;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  a1 := pg_temp.w(pg_temp.q_add(11, pg_temp.id('DA1'), 'Book the movers', NULL, NULL, 'req-add-1'));
  n0 := (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE owner_user_id = A);
  a2 := pg_temp.w(pg_temp.q_add(11, pg_temp.id('DA1'), 'Book the movers', NULL, NULL, 'req-add-1'));
  a3 := pg_temp.w(pg_temp.q_add(11, pg_temp.id('DA1'), 'Book the movers'));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(a1) = 'added', 'add ' || a1::text),
    pg_temp.pass(pg_temp.ws(a2) = 'added' AND a2 -> 'result' -> 'item' ->> 'item_id' = a1 -> 'result' -> 'item' ->> 'item_id', 'replayed add ' || a2::text),
    pg_temp.pass(pg_temp.ws(a3) = 'already_added' AND a3 -> 'result' -> 'item' ->> 'item_id' = a1 -> 'result' -> 'item' ->> 'item_id', 'window add ' || a3::text),
    pg_temp.pass((SELECT count(*) FROM public.cloud_deal_checklist_items WHERE owner_user_id = A) = n0, 'duplicate item'),
    -- remove and restore retried without a request_id give the settled answer and write nothing
    pg_temp.pass(pg_temp.ws(pg_temp.w(pg_temp.q_rm(11, pg_temp.id('m2')))) = 'removed' AND pg_temp.ws(pg_temp.w(pg_temp.q_rm(11, pg_temp.id('m2')))) = 'already_removed', 'remove retry'));
END $c$;

-- ---------------------------------------------------------------- W12: a note the app could not see whole is not replaced
CREATE FUNCTION pg_temp.c_note() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); m3 uuid := pg_temp.id('m3'); n0 text; r jsonb; cl jsonb;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  n0 := (pg_temp.it(m3)).note;
  r := pg_temp.w(pg_temp.q_upd(11, m3, '{"note":"short now"}'));
  cl := pg_temp.w(pg_temp.q_cl(11, pg_temp.id('DA1')));
  RETURN pg_temp.all_of(
    pg_temp.pass(char_length(n0) > 1000, 'fixture note length ' || char_length(n0)),
    pg_temp.pass(pg_temp.ws(r) = 'note_was_shortened' AND (pg_temp.it(m3)).note = n0, 'shortened ' || left(r::text, 300)),
    pg_temp.pass((r -> 'result' -> 'item' -> 'note_complete')::boolean IS FALSE, 'note_complete'),
    pg_temp.pass((SELECT (x -> 'note_complete')::boolean FROM jsonb_array_elements(cl -> 'result' -> 'checklists') c, jsonb_array_elements(c -> 'items') x
                   WHERE x ->> 'item_id' = m3::text) IS FALSE, 'frame v2 note_complete'),
    -- other parts of the same item still change; a short note is replaced
    pg_temp.pass(pg_temp.ws(pg_temp.w(pg_temp.q_upd(11, m3, '{"done":true}'))) = 'applied', 'other part'),
    pg_temp.pass(pg_temp.ws(pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m1'), '{"note":"fine"}'))) = 'applied', 'short note'));
END $c$;

-- ---------------------------------------------------------------- the sort_order an AI create sends (carry b)
CREATE FUNCTION pg_temp.c_order() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); a1 jsonb; a2 jsonb; i1 uuid; i2 uuid; cl record;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  a1 := pg_temp.w(pg_temp.q_add(11, pg_temp.id('DA1'), 'After the others', 'a note', '2026-12-24'));
  a2 := pg_temp.w(pg_temp.q_add(11, pg_temp.id('DA2'), 'First on a new list'));
  i1 := (a1 -> 'result' -> 'item' ->> 'item_id')::uuid; i2 := (a2 -> 'result' -> 'item' ->> 'item_id')::uuid;
  SELECT c.template_id, c.sort_order, c.local_checklist_id = c.id::text AS lid_is_id INTO cl FROM public.cloud_deal_checklists c WHERE c.id = (pg_temp.it(i2)).cloud_checklist_id;
  PERFORM pg_temp.rec('obs_ai_create', jsonb_build_object('existing_list_order', (pg_temp.it(i1)).sort_order, 'new_list_item_order', (pg_temp.it(i2)).sort_order,
    'new_list', to_jsonb(cl), 'local_item_id_is_id', (pg_temp.it(i1)).local_item_id = i1::text, 'note', (pg_temp.it(i1)).note, 'due', (pg_temp.it(i1)).due_date));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(a1) = 'added' AND (pg_temp.it(i1)).sort_order = 3, 'next free place (live My items 0,1,2; the removed one at 3 skipped) ' || coalesce((pg_temp.it(i1)).sort_order::text, 'null')),
    pg_temp.pass((pg_temp.it(i1)).note = 'a note' AND (pg_temp.it(i1)).due_date = DATE '2026-12-24' AND (pg_temp.it(i1)).local_item_id = i1::text, 'values'),
    pg_temp.pass(pg_temp.ws(a2) = 'added' AND (pg_temp.it(i2)).sort_order = 0 AND cl.template_id = 'keepr:my-items', 'new list ' || a2::text),
    pg_temp.pass((a1 -> 'result' -> 'item' -> 'editable_title')::boolean AND (a1 -> 'result' -> 'item' -> 'removable')::boolean, 'my item flags'));
END $c$;

-- ---------------------------------------------------------------- arguments: bounds and types; no write, no core call
CREATE FUNCTION pg_temp.c_input() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); s0 text; m uuid := pg_temp.id('m1'); bad text[] := '{}'; q text; r jsonb;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  s0 := pg_temp.state(A);
  FOREACH q IN ARRAY ARRAY[
      format('SELECT public.mcp_update_todo(%L, %L::bytea, %L, %L, %L::jsonb, NULL)', pg_temp.secret(), pg_temp.dgl(11), pg_temp.res(), 'not-a-uuid', '{"done":true}'),
      pg_temp.q_upd(11, m, '{}'),
      pg_temp.q_upd(11, m, '{"done":"yes"}'),
      pg_temp.q_upd(11, m, '{"sort_order":1}'),
      pg_temp.q_upd(11, m, '{"title":5}'),
      pg_temp.q_upd(11, m, '{"title":"   "}'),
      pg_temp.q_upd(11, m, jsonb_build_object('title', repeat('x', 301))),
      pg_temp.q_upd(11, m, jsonb_build_object('title', repeat('x', 2001))),
      pg_temp.q_upd(11, m, jsonb_build_object('note', repeat('x', 4001))),
      pg_temp.q_upd(11, m, jsonb_build_object('note', repeat('x', 16001))),
      pg_temp.q_upd(11, m, '{"due_date":"2026-13-01"}'),
      pg_temp.q_upd(11, m, '{"due_date":"2101-01-01"}'),
      pg_temp.q_upd(11, m, '{"due_date":"01/12/2026"}'),
      pg_temp.q_upd(11, m, '"done"'),
      pg_temp.q_upd(11, m, '{"done":true}', 'has space'),
      pg_temp.q_upd(11, m, '{"done":true}', repeat('r', 101)),
      pg_temp.q_add(11, pg_temp.id('DA1'), NULL),
      pg_temp.q_add(11, pg_temp.id('DA1'), ''),
      pg_temp.q_add(11, pg_temp.id('DA1'), 'ok', NULL, '2026-1-1'),
      pg_temp.q_add(11, pg_temp.id('DA1'), 'ok', repeat('x', 4001)),
      format('SELECT public.mcp_add_todo(%L, %L::bytea, %L, %L, %L, NULL, NULL, NULL)', pg_temp.secret(), pg_temp.dgl(11), pg_temp.res(), 'DA1''; DROP TABLE x; --', 'ok'),
      format('SELECT public.mcp_remove_todo(%L, %L::bytea, %L, NULL, NULL)', pg_temp.secret(), pg_temp.dgl(11), pg_temp.res())] LOOP
    r := pg_temp.w(q);
    IF r IS DISTINCT FROM '{"ok":false,"error":"invalid_input"}'::jsonb THEN bad := bad || (left(q, 160) || ' -> ' || coalesce(r::text, 'null')); END IF;
  END LOOP;
  s0 := CASE WHEN pg_temp.state(A) = s0 THEN 'same' ELSE 'changed' END;
  r := pg_temp.w(pg_temp.q_upd(11, m, jsonb_build_object('title', 'Phone' || chr(8203) || ' the' || chr(8288) || ' bank' || chr(7))));
  RETURN pg_temp.all_of(
    pg_temp.pass(cardinality(bad) = 0, array_to_string(bad, ' || ')),
    pg_temp.pass(s0 = 'same', 'state changed'),
    -- invisible characters are removed before the length check and before storing
    pg_temp.pass(pg_temp.ws(r) = 'applied' AND (pg_temp.it(m)).title = 'Phone the bank', 'stripped title ' || r::text));
END $c$;

-- ---------------------------------------------------------------- 500 writes a day per user
CREATE FUNCTION pg_temp.c_rate() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); s0 text; s1 text; r jsonb; r4 jsonb; r3 jsonb; s4 text; c4 int; c3 int;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  INSERT INTO public.mcp_rate_counters (bucket, window_start, count) VALUES ('todo_write_user:' || A::text, public._mcp_window(interval '1 day'), 500);
  s0 := pg_temp.state(A);
  r := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m1'), '{"done":true}'));
  s1 := pg_temp.state(A);
  -- parts count: 497 used, a four-part update does not fit (nothing added, nothing written), a three-part one does
  UPDATE public.mcp_rate_counters SET count = 497 WHERE bucket = 'todo_write_user:' || A::text;
  r4 := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m1'), '{"done":true,"title":"Four","note":"four","due_date":"2026-12-01"}'));
  s4 := pg_temp.state(A);
  c4 := (SELECT count FROM public.mcp_rate_counters WHERE bucket = 'todo_write_user:' || A::text);
  r3 := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m1'), '{"done":true,"title":"Three","note":"three"}'));
  c3 := (SELECT count FROM public.mcp_rate_counters WHERE bucket = 'todo_write_user:' || A::text);
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(r) = 'E:rate_limited', 'status ' || r::text),
    pg_temp.pass(s1 = s0, 'state changed'),
    pg_temp.pass(pg_temp.ws(r4) = 'E:rate_limited' AND s4 = s0 AND c4 = 497, 'four parts at 497 ' || r4::text || ' count ' || c4),
    pg_temp.pass(pg_temp.ws(r3) = 'applied' AND c3 = 500, 'three parts at 497 ' || r3::text || ' count ' || coalesce(c3::text, 'null')),
    pg_temp.pass(pg_temp.ws(pg_temp.w(pg_temp.q_upd(12, pg_temp.id('b1'), '{"done":true}'))) = 'applied', 'other user unaffected'));
END $c$;

-- ---------------------------------------------------------------- not entitled, turned off, revoked, expired, MCP disabled
CREATE FUNCTION pg_temp.c_access() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; r5 jsonb; r6 jsonb; s0 text;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  r1 := pg_temp.w(pg_temp.q_upd(13, pg_temp.id('m1'), '{"done":true}'));
  r6 := pg_temp.w(replace(pg_temp.q_upd(11, pg_temp.id('m1'), '{"done":true}'), pg_temp.secret(), 'wrong-secret'));
  UPDATE public.cloud_autosave_settings SET enabled = false WHERE user_id = A;
  s0 := pg_temp.state(A);
  r2 := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m1'), '{"done":true}'));
  UPDATE public.cloud_autosave_settings SET enabled = true WHERE user_id = A;
  PERFORM pg_temp.rpc(A, format('SELECT public.mcp_disconnect(%L::uuid)', pg_temp.id('KA_todos')));
  r3 := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m1'), '{"done":true}'));
  UPDATE public.mcp_settings SET enabled = false WHERE id;
  r4 := pg_temp.w(pg_temp.q_upd(12, pg_temp.id('b1'), '{"done":true}'));
  r5 := pg_temp.w(pg_temp.q_wa(12));
  RETURN pg_temp.all_of(
    pg_temp.pass(r1 = '{"ok":false,"error":"not_connected"}'::jsonb, 'expired ' || r1::text),
    pg_temp.pass(r6 = '{"ok":false,"error":"not_connected"}'::jsonb, 'wrong secret ' || r6::text),
    pg_temp.pass(r2 = '{"ok":false,"error":"not_entitled"}'::jsonb AND pg_temp.state(A) = s0, 'not entitled ' || r2::text),
    pg_temp.pass(r3 = '{"ok":false,"error":"not_connected"}'::jsonb, 'disconnected ' || r3::text),
    pg_temp.pass(r4 = '{"ok":false,"error":"disabled"}'::jsonb, 'mcp off ' || r4::text),
    pg_temp.pass(r5 = '{"ok":false,"error":"not_connected"}'::jsonb, 'write_access with mcp off ' || r5::text));
END $c$;
-- turning Keepr Cloud off disconnects the app; its next write is refused
CREATE FUNCTION pg_temp.c_turn_off() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); off_ jsonb; r jsonb;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  off_ := pg_temp.onoff(A, false);
  r := pg_temp.w(pg_temp.q_upd(11, pg_temp.id('m1'), '{"done":true}'));
  RETURN pg_temp.all_of(
    pg_temp.pass(off_ ->> 'success' = 'true', 'turn off ' || off_::text),
    pg_temp.pass(r = '{"ok":false,"error":"not_connected"}'::jsonb, 'after turn-off ' || r::text),
    pg_temp.pass((SELECT count(*) FROM public.cloud_deal_checklist_items WHERE owner_user_id = A) = 0
                 AND (SELECT count(*) FROM public.cloud_todo_history WHERE owner_user_id = A) = 0, 'rows left'));
END $c$;

-- ---------------------------------------------------------------- C25: the caller's claims are as they came, on every path, from every start shape
CREATE FUNCTION pg_temp.c_claims() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE s int; q text; p jsonb; bad text[] := '{}'; n int := 0;
BEGIN
  PERFORM pg_temp.sw(true);
  FOREACH s IN ARRAY ARRAY[1, 2, 3] LOOP
    PERFORM pg_temp.unrate();
    FOREACH q IN ARRAY ARRAY[
        pg_temp.q_upd(11, pg_temp.id('m1'), jsonb_build_object('note', 'claims ' || s)),     -- applied
        pg_temp.q_upd(11, pg_temp.id('l1'), '{"done":true}'),                                -- locked (block rolled back)
        pg_temp.q_upd(11, pg_temp.id('t1'), '{"done":true,"title":"x"}'),                    -- refused after one part applied
        pg_temp.q_upd(11, pg_temp.id('m1'), '{"due_date":"2101-01-01"}'),                    -- core rejects the value
        pg_temp.q_upd(11, pg_temp.id('m1'), '{}'),                                           -- invalid before the block
        pg_temp.q_upd(1, pg_temp.id('m1'), '{"done":true}'),                                 -- read_only
        pg_temp.q_add(11, pg_temp.id('DA1'), 'claims add ' || s)] LOOP                       -- added
      p := pg_temp.wp(q, s); n := n + 1;
      IF p -> 'before' IS DISTINCT FROM p -> 'after' OR p ? 'sqlerr' OR (s IN (1, 2) AND p -> 'after' ->> 'auth_role' IS DISTINCT FROM 'anon')
         OR p -> 'after' -> 'auth_uid' <> 'null'::jsonb THEN
        bad := bad || ('shape ' || s || ' ' || left(q, 60) || ' -> ' || p::text);
      END IF;
    END LOOP;
  END LOOP;
  PERFORM pg_temp.rec('obs_claims_runs', to_jsonb(n));
  RETURN pg_temp.pass(cardinality(bad) = 0 AND n = 21, coalesce(array_to_string(bad, ' || '), '') || ' n=' || n);
END $c$;

-- ---------------------------------------------------------------- second actor: AI app and desktop on one todo
CREATE FUNCTION pg_temp.c_second_actor() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); IA uuid := pg_temp.id('IA'); m uuid := pg_temp.id('m1'); m2 uuid := pg_temp.id('m2');
        rev0 bigint; r1 jsonb; d1 jsonb; d2 jsonb; d3 jsonb; a4 jsonb; lost bigint; ev bigint; p jsonb;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  rev0 := (pg_temp.it(m)).note_rev;
  r1 := pg_temp.w(pg_temp.q_upd(11, m, '{"note":"from Claude"}'));
  -- the desktop edited the same part an hour ago, offline, on the old base: the AI change is later and wins
  d1 := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(m, 'note', '"from the desktop, earlier"', rev0, 5, pg_temp.nowt('-1 hour'))));
  -- the desktop ticks a different part on its old base: both kept
  d2 := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(m, 'done', '{"is_checked":true,"checked_at":null}', (pg_temp.it(m)).done_rev, 6, pg_temp.nowt())));
  -- the desktop edits the note after the AI change, seeing it (base = the AI's rev): applied
  d3 := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(m, 'note', '"desktop, later"', (pg_temp.it(m)).note_rev, 7, pg_temp.nowt())));
  lost := (SELECT count(*) FROM public.cloud_todo_history WHERE entity_id = m AND outcome = 'lost' AND kind = 'change' AND actor_kind = 'desktop');
  ev := (SELECT count(*) FROM public.cloud_todo_history WHERE entity_id = m AND kind = 'conflict');
  -- the desktop removed a todo; the AI app's edit of it is refused
  PERFORM pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.op('remove', 'item', m2)));
  a4 := pg_temp.w(pg_temp.q_upd(11, m2, '{"done":true}'));
  -- what the desktop's pull carries for the AI change: the part's by and its new rev
  p := pg_temp.pull(A, IA, 0, 500, NULL);
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(r1) = 'applied', 'ai ' || r1::text),
    pg_temp.pass(d1 -> 'results' -> 0 ->> 'status' = 'lost' AND lost = 1 AND ev >= 1, 'desktop earlier ' || d1::text),
    pg_temp.pass(d2 -> 'results' -> 0 ->> 'status' = 'applied', 'desktop other part ' || d2::text),
    pg_temp.pass(d3 -> 'results' -> 0 ->> 'status' = 'applied' AND (pg_temp.it(m)).note = 'desktop, later' AND (pg_temp.it(m)).is_checked, 'desktop later ' || d3::text),
    pg_temp.pass(pg_temp.ws(a4) = 'is_removed', 'ai on removed ' || a4::text),
    pg_temp.pass(EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'rows') x WHERE x ->> 'cloud_id' = m::text), 'pull has the item'));
END $c$;

-- ---------------------------------------------------------------- write access answer
CREATE FUNCTION pg_temp.c_write_access() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE l0 bigint := (SELECT count(*) FROM public.mcp_call_log); a jsonb; b jsonb; c jsonb; d jsonb; e jsonb; f jsonb;
BEGIN
  PERFORM pg_temp.sw(true);
  a := pg_temp.w(pg_temp.q_wa(11)); b := pg_temp.w(pg_temp.q_wa(1)); c := pg_temp.w(pg_temp.q_wa(13)); d := pg_temp.w(pg_temp.q_wa(11, 'wrong-secret'));
  f := pg_temp.w(format('SELECT public.mcp_write_access(%L, %L::bytea, %L)', pg_temp.secret(), pg_temp.dgl(11), 'https://other-portal.example.test/api/mcp'));
  PERFORM pg_temp.sw(false);
  e := pg_temp.w(pg_temp.q_wa(11));
  RETURN pg_temp.all_of(
    pg_temp.pass(a = '{"ok":true,"write":true}'::jsonb, 'todos on ' || a::text),
    pg_temp.pass(b = '{"ok":true,"write":false}'::jsonb, 'read on ' || b::text),
    pg_temp.pass(c = '{"ok":false,"error":"not_connected"}'::jsonb, 'expired ' || c::text),
    pg_temp.pass(d = '{"ok":false,"error":"not_connected"}'::jsonb, 'secret ' || d::text),
    pg_temp.pass(e = '{"ok":true,"write":false}'::jsonb, 'todos off ' || e::text),
    pg_temp.pass(f = '{"ok":false,"error":"not_connected"}'::jsonb, 'another resource ' || f::text),
    pg_temp.pass((SELECT count(*) FROM public.mcp_call_log) = l0, 'logged'));
END $c$;

-- ---------------------------------------------------------------- frame: v1 byte for byte while off, v2 while on
CREATE FUNCTION pg_temp.c_frame() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); v1 jsonb; v2 jsonb; w1 jsonb; keys1 text; keys2 text; mi jsonb; ti jsonb;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(false);
  v1 := pg_temp.reader(A, pg_temp.id('DA1'));
  w1 := pg_temp.w(pg_temp.q_cl(1, pg_temp.id('DA1')));
  PERFORM pg_temp.sw(true);
  v2 := pg_temp.reader(A, pg_temp.id('DA1'));
  SELECT string_agg(k, ',' ORDER BY k) INTO keys1 FROM jsonb_object_keys(v1 -> 'checklists' -> 0 -> 'items' -> 0) k;
  SELECT string_agg(k, ',' ORDER BY k) INTO keys2 FROM jsonb_object_keys(v2 -> 'checklists' -> 0 -> 'items' -> 0) k;
  SELECT x INTO mi FROM jsonb_array_elements(v2 -> 'checklists') c, jsonb_array_elements(c -> 'items') x WHERE x ->> 'item_id' = pg_temp.id('m1')::text;
  SELECT x INTO ti FROM jsonb_array_elements(v2 -> 'checklists') c, jsonb_array_elements(c -> 'items') x WHERE x ->> 'item_id' = pg_temp.id('t1')::text;
  RETURN pg_temp.all_of(
    pg_temp.pass(v1::text = pg_temp.fxv('reader_v1_before'), 'v1 differs from the reader before the migration'),
    pg_temp.pass(w1 -> 'result' = v1, 'wrapper v1'),
    pg_temp.pass((v2 -> 'v')::int = 2 AND keys2 = 'description,done,done_at,due_date,editable_title,expected_document,item_id,note,note_complete,removable,required,title'
                 AND keys1 = 'description,done,done_at,expected_document,item_id,note,required,title', 'keys ' || keys1 || ' / ' || keys2),
    pg_temp.pass((mi -> 'editable_title')::boolean AND (mi -> 'removable')::boolean AND (mi -> 'note_complete')::boolean AND mi -> 'due_date' = 'null'::jsonb, 'my item ' || mi::text),
    pg_temp.pass((ti -> 'editable_title')::boolean IS FALSE AND (ti -> 'removable')::boolean IS FALSE, 'template item ' || ti::text),
    pg_temp.pass((v2 - 'v' - 'checklists') = (v1 - 'v' - 'checklists'), 'rest of frame'));
END $c$;

-- ---------------------------------------------------------------- catalogue: anon list, grants, attributes, internal functions
CREATE FUNCTION pg_temp.c_catalog() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE anon_list text[]; probs jsonb;
BEGIN
  SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) INTO anon_list FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE');
  SELECT coalesce(jsonb_object_agg(x.sig, x.problem), '{}') INTO probs FROM (
    SELECT s.sig, CASE WHEN p.oid IS NULL THEN 'missing'
                       WHEN array_to_string(p.proconfig, ',') IS DISTINCT FROM 'search_path=""' THEN 'search_path'
                       WHEN s.kind = 'anon' AND (NOT p.prosecdef OR NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                                                 OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN 'anon grants'
                       WHEN s.kind = 'internal' AND (p.prosecdef OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                                                     OR has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN 'internal grants'
                       WHEN s.kind = 'switch' AND (NOT p.prosecdef OR NOT has_function_privilege('mcp_reader', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
                                                   OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN 'switch grants'
                       WHEN coalesce(p.proacl::text ~ '(^|[{,])=X', p.proacl IS NULL) THEN 'PUBLIC execute' END AS problem
      FROM (VALUES ('public.mcp_write_access(text,bytea,text)', 'anon'), ('public.mcp_update_todo(text,bytea,text,text,jsonb,text)', 'anon'),
                   ('public.mcp_add_todo(text,bytea,text,text,text,text,text,text)', 'anon'), ('public.mcp_remove_todo(text,bytea,text,text,text)', 'anon'),
                   ('public.mcp_restore_todo(text,bytea,text,text,text)', 'anon'), ('public._mcp_todo_call(text,bytea,text,text,jsonb)', 'internal'),
                   ('public._mcp_todo_item_out(uuid,uuid)', 'internal'), ('public._mcp_conn_can_write(uuid)', 'internal'),
                   ('public._mcp_granted_scope(text)', 'internal'), ('public._mcp_writes_on()', 'switch')) s(sig, kind)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(s.sig)) x WHERE x.problem IS NOT NULL;
  RETURN pg_temp.all_of(
    pg_temp.pass(anon_list = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY['mcp_add_todo(text,bytea,text,text,text,text,text,text)', 'mcp_authorize_begin(text,text,text,text,text,text,text,text,bytea,bytea)',
        'mcp_check_access(text,bytea,text)', 'mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)', 'mcp_get_deal(text,bytea,text,text)',
        'mcp_get_deal_checklists(text,bytea,text,text,boolean,text)', 'mcp_get_status(text,bytea,text)', 'mcp_list_all_deals(text,bytea,text,text,text,text,text)',
        'mcp_list_deals(text,bytea,text,text,text,integer,text)', 'mcp_refresh(text,bytea,text,text,bytea,bytea)', 'mcp_register_client(text,text,text,text[],bytea)',
        'mcp_remove_todo(text,bytea,text,text,text)', 'mcp_restore_todo(text,bytea,text,text,text)', 'mcp_update_todo(text,bytea,text,text,jsonb,text)',
        'mcp_write_access(text,bytea,text)']) x), 'anon list ' || anon_list::text),
    pg_temp.pass(probs = '{}'::jsonb, 'attributes ' || probs::text),
    pg_temp.pass(public._mcp_reader_ok('public._mcp_r_deal_checklists(uuid,boolean,uuid)'::regprocedure), 'reader owner/stable/definer'),
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = 'mcp_reader'::regrole::oid AND p.prosrc ~ 'public\.cloud_deals\M'
                             AND p.prosrc !~ 'removed_at IS NULL'), 'reader removed filter'),
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'mcp_reader']) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) pr
                             WHERE has_table_privilege(r, 'public.mcp_write_settings', pr))
                 AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.mcp_write_settings'::regclass), 'switch table privileges'),
    -- no mcp function names the core's desktop RPCs, restore of a deal, or the purge
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_'
                             AND p.prosrc ~ '(cloud_todo_push|cloud_todo_restore|cloud_purge_deal_now|_cloud_todo_purge|cloud_delete_deal|cloud_delete_install|set_my_cloud_autosave)'), 'mcp names a desktop path'));
END $c$;

-- ---------------------------------------------------------------- lock order (SR delta review 1, L1): a write holds the owner's settings row
-- before its first lock on the connection row (turn-off locks settings first and deletes connections last). A trigger
-- on that first lock records whether this transaction already holds the settings row lock; a stale xmax from an
-- aborted earlier control is not counted (pg_xact_status must be 'in progress'). Trigger, function and fixture are
-- created inside the control, so iso() rolls them back with it.
CREATE TEMP TABLE p5_lockobs (o serial, settings_locked boolean);
CREATE FUNCTION pg_temp.c_lock_order() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r jsonb; obs boolean[];
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(true);
  EXECUTE $ddl$
    CREATE FUNCTION public.p5_lockobs_fn() RETURNS trigger LANGUAGE plpgsql AS $t$
    BEGIN
      INSERT INTO pg_temp.p5_lockobs (settings_locked)
      SELECT coalesce((SELECT s.xmax::text <> '0'
                          AND pg_xact_status((((pg_current_xact_id()::text::bigint >> 32) << 32) + s.xmax::text::bigint)::text::xid8) = 'in progress'
                         FROM public.cloud_autosave_settings s WHERE s.user_id = NEW.user_id), false);
      RETURN NEW;
    END $t$ $ddl$;
  EXECUTE 'REVOKE ALL ON FUNCTION public.p5_lockobs_fn() FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE 'CREATE TRIGGER p5_lockobs BEFORE UPDATE ON public.mcp_connections FOR EACH ROW EXECUTE FUNCTION public.p5_lockobs_fn()';
  INSERT INTO public.cloud_autosave_settings (user_id) VALUES (pg_temp.id('C')) ON CONFLICT (user_id) DO NOTHING;
  PERFORM pg_temp.conn('KC_todos', pg_temp.id('C'), 71, 'mcp:todos');
  DELETE FROM pg_temp.p5_lockobs;
  r := pg_temp.w(pg_temp.q_upd(71, md5('p5-l1')::uuid, '{"done":true}'));
  obs := (SELECT array_agg(settings_locked ORDER BY o) FROM pg_temp.p5_lockobs);
  RETURN pg_temp.pass(obs = ARRAY[true], jsonb_build_object('obs', obs, 'res', pg_temp.ws(r))::text);
END $c$;
