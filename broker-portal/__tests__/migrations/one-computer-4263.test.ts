/**
 * BACKLOG-4263 (sync 2.49, P1): static checks of migration 20261123100000_backlog_4263_one_computer.sql.
 *
 * C-0: every replaced body is re-derived here from the head migration text (20261118110000, 20261118120000,
 * 20261112190000) by applying named insert templates at named anchors, and must equal the body in the S1 file byte for
 * byte. The head text is tied to production by the md5 pins in supabase/tests/backlog-4263-prod/postcheck-final.sql
 * (the state answer, written before the lane, is pinned here). The two blob functions change signature and are
 * checked by the separate assertions below instead.
 *
 * CI has no database: what the SQL does when it runs is checked by supabase/tests/backlog-4263-sync2-s1/ on the test
 * project.
 */

import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIG = join(REPO, 'supabase/migrations');
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

const S1_FILE = '20261123100000_backlog_4263_one_computer.sql';
const M1 = read(join(MIG, '20261112190000_backlog_4236_cloud_autosave_schema.sql'));
const M2 = read(join(MIG, '20261118110000_backlog_4263_todo_server_core.sql'));
const M3 = read(join(MIG, '20261118120000_backlog_4263_todo_old_item_path_removed.sql'));
const S1 = read(join(MIG, S1_FILE));
const FINAL = read(join(REPO, 'supabase/tests/backlog-4263-prod/postcheck-final.sql'));

/** md5 of the state answer's body as 20261112190000 wrote it (not covered by postcheck-final: written before the lane). */
const STATE_HEAD_MD5 = '9d146e4f0f190c7c2d778926eff87671';

/** Dollar-quoted body of the last top-level CREATE of public.<name> in sql. */
function body(sql: string, name: string): string {
  const re = new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`, 'gm');
  let m: RegExpExecArray | null;
  let last = -1;
  while ((m = re.exec(sql)) !== null) last = m.index;
  if (last < 0) throw new Error(`${name}: not defined`);
  const as = /\bAS (\$[A-Za-z_]*\$)/g;
  as.lastIndex = last;
  const a = as.exec(sql);
  if (!a) throw new Error(`${name}: no body`);
  const start = a.index + a[0].length;
  return sql.slice(start, sql.indexOf(a[1], start));
}
/** The whole statement (header to `$tag$;`) of the last top-level CREATE of public.<name>. */
function statement(sql: string, name: string): string {
  const re = new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`, 'gm');
  let m: RegExpExecArray | null;
  let last = -1;
  while ((m = re.exec(sql)) !== null) last = m.index;
  const b = body(sql, name);
  const end = sql.indexOf(b, last) + b.length;
  return sql.slice(last, sql.indexOf(';\n', end) + 1);
}
const count = (s: string, sub: string): number => s.split(sub).length - 1;

type Insert = { anchor: string; where: 'before' | 'after'; block: string };
type Spec = { head: string; pin: string | 'none'; inserts: Insert[] };

/** The install_removed gate block of a writer (3 lines) — the anchor the active gate goes after. */
function installGate(b: string, short: string): string {
  const m = new RegExp(`^.*/\\*GATE:install:${short}\\*/\\n.*\\n  END IF;\\n`, 'm').exec(b);
  if (!m) throw new Error(`${short}: install gate not found`);
  return m[0];
}
function activeGate(short: string, inst: string): string {
  return (
    `  IF public._cloud_install_inactive(v_uid, ${inst}) THEN`.padEnd(92) +
    ` /*GATE:active:${short}*/\n` +
    "    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');\n" +
    '  END IF;\n'
  );
}

const WRITERS: Array<[string, string, string, string]> = [
  // name, head text, gate name, install expression
  ['cloud_todo_push', M2, 'push', 'p_source_install_id'],
  ['cloud_upsert_deal', M2, 'deal', 'v_inst'],
  ['cloud_upsert_parties', M2, 'parties', 'p_source_install_id'],
  ['cloud_upsert_messages', M2, 'messages', 'p_source_install_id'],
  ['cloud_upsert_files', M2, 'files', 'p_source_install_id'],
  ['cloud_mark_deal_synced', M2, 'mark_synced', 'p_source_install_id'],
  ['cloud_tombstone', M3, 'tombstone', 'p_source_install_id'],
];

const SET_OFF: Insert = {
  anchor: '  -- Off: one unit. Any error undoes all of it and the call is refused.\n',
  where: 'before',
  block: `  -- One computer (20261123100000): while the switch is on, a computer is active and the caller is licensed, only the
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
`,
};
const SET_CLEAR: Insert = {
  anchor:
    '    UPDATE public.cloud_autosave_settings SET enabled = false, disabled_at = now(), updated_at = now() WHERE user_id = v_uid;\n',
  where: 'after',
  block:
    '    UPDATE public.cloud_autosave_settings SET active_install_id = NULL, active_since = NULL WHERE user_id = v_uid;   /*SET:active:clear*/\n',
};
const STATE_KEYS: Insert = {
  anchor: "    'current_notice_version', v_cur,\n",
  where: 'after',
  block: `    'active_install_id', s.active_install_id,                                                         /*STATE:active*/
    'switches', coalesce((SELECT jsonb_build_object('one_computer', w.one_computer, 'messages_upload', w.messages_upload)
                            FROM public.cloud_release_switches w WHERE w.id),
                         jsonb_build_object('one_computer', false, 'messages_upload', false)),         /*STATE:switches*/
`,
};

const SPECS: Record<string, Spec> = {};
for (const [name, text, short, inst] of WRITERS) {
  const head = body(text, name);
  SPECS[name] = { head, pin: 'final', inserts: [{ anchor: installGate(head, short), where: 'after', block: activeGate(short, inst) }] };
}
SPECS.set_my_cloud_autosave = { head: body(M2, 'set_my_cloud_autosave'), pin: 'final', inserts: [SET_OFF, SET_CLEAR] };
SPECS.get_my_cloud_autosave_state = { head: body(M1, 'get_my_cloud_autosave_state'), pin: 'none', inserts: [STATE_KEYS] };

function derive(spec: Spec): string {
  let out = spec.head;
  for (const ins of spec.inserts) {
    expect(count(out, ins.anchor)).toBe(1);
    const i = out.indexOf(ins.anchor) + (ins.where === 'after' ? ins.anchor.length : 0);
    out = out.slice(0, i) + ins.block + out.slice(i);
  }
  return out;
}
/** name -> md5 pinned by postcheck-final.sql. */
const FINAL_PINS = new Map<string, string>(
  [...FINAL.matchAll(/^ {4}\('public\.(\w+)\([^)]*\)', '([0-9a-f]{32})',/gm)].map((m) => [m[1], m[2]] as [string, string]),
);

describe('BACKLOG-4263 S1 one computer: C-0 replaced bodies', () => {
  it('the file is the only migration at its version', () => {
    expect(readdirSync(MIG).filter((f) => f.startsWith('20261123100000'))).toEqual([S1_FILE]);
  });

  it.each(Object.keys(SPECS))('%s: the head text is the body production holds before S1 (md5 pin)', (name) => {
    const spec = SPECS[name];
    const want = spec.pin === 'final' ? FINAL_PINS.get(name) : STATE_HEAD_MD5;
    expect(want).toMatch(/^[0-9a-f]{32}$/);
    expect(`${name} ${md5(spec.head)}`).toBe(`${name} ${want}`);
  });

  it.each(Object.keys(SPECS))('%s: S1 body = head body + the named inserts, byte for byte', (name) => {
    const derived = derive(SPECS[name]);
    const got = body(S1, name);
    expect(got.length).toBeGreaterThan(SPECS[name].head.length);
    expect(got).toBe(derived);
  });

  it.each(Object.keys(SPECS))('%s: the pre-check accepts exactly the head body and this file\'s body', (name) => {
    const pre = S1.slice(S1.indexOf('DO $pre4263s1$'), S1.indexOf('$pre4263s1$;'));
    expect(pre).toContain(`'${md5(SPECS[name].head)}'`);
    expect(pre).toContain(`'${md5(body(S1, name))}'`);
  });

  it.each(WRITERS.map((w) => w[0]))('%s: the active gate sits after the settings lock and the install gate', (name) => {
    const short = WRITERS.find((w) => w[0] === name)![2];
    const b = body(S1, name);
    const lock = b.indexOf('FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;');
    const inst = b.indexOf(`/*GATE:install:${short}*/`);
    const act = b.indexOf(`/*GATE:active:${short}*/`);
    expect(lock).toBeGreaterThan(0);
    expect(inst).toBeGreaterThan(lock);
    expect(act).toBeGreaterThan(inst);
    expect(count(b, '/*GATE:active:')).toBe(1);
  });

  it('header lines of the seven writers and the state answer are unchanged; set_my_cloud_autosave gains only the install argument', () => {
    const hdr = (sql: string, name: string): string => {
      const st = statement(sql, name);
      return st.slice(0, st.indexOf(body(sql, name)));
    };
    for (const [name, text] of WRITERS) expect(hdr(S1, name)).toBe(hdr(text, name));
    expect(hdr(S1, 'get_my_cloud_autosave_state')).toBe(hdr(M1, 'get_my_cloud_autosave_state'));
    expect(hdr(S1, 'set_my_cloud_autosave')).toBe(
      hdr(M2, 'set_my_cloud_autosave').replace(
        'p_notice_version integer DEFAULT NULL) RETURNS jsonb',
        'p_notice_version integer DEFAULT NULL,\n                                                      p_source_install_id uuid DEFAULT NULL) RETURNS jsonb',
      ),
    );
  });
});

describe('BACKLOG-4263 S1 one computer: acceptance conditions readable from the text', () => {
  const fnNames = [...S1.matchAll(/^CREATE OR REPLACE FUNCTION public\.(\w+)\(/gm)].map((m) => m[1]);
  const sigOf = (name: string): string => {
    const m = new RegExp(`^REVOKE ALL ON FUNCTION public\\.${name}\\(([^)]*)\\) FROM PUBLIC, anon, authenticated, service_role;$`, 'm').exec(S1);
    if (!m) throw new Error(`${name}: no full-signature revoke`);
    return m[1];
  };
  const ROLE: Record<string, string | null> = {
    _cloud_install_inactive: null,
    cloud_computer_move_notice_claim: 'service_role',
    cloud_computer_move_notice_done: 'service_role',
  };

  it('defines the expected functions, each once', () => {
    expect([...fnNames].sort()).toEqual(
      [
        '_cloud_install_inactive', 'cloud_claim_install', 'cloud_computer_move_notice_claim', 'cloud_computer_move_notice_done',
        'cloud_confirm_blob', 'cloud_mark_deal_synced', 'cloud_register_blob', 'cloud_todo_push', 'cloud_tombstone',
        'cloud_upsert_deal', 'cloud_upsert_files', 'cloud_upsert_messages', 'cloud_upsert_parties',
        'get_my_cloud_autosave_state', 'set_my_cloud_autosave',
      ].sort(),
    );
  });

  it.each(fnNames)('%s: revoked from PUBLIC, anon, authenticated, service_role, then granted to its one caller only', (name) => {
    const sig = sigOf(name);
    const grants = [...S1.matchAll(new RegExp(`^GRANT EXECUTE ON FUNCTION public\\.${name}\\(([^)]*)\\) TO (\\w+);$`, 'gm'))];
    const want = name in ROLE ? ROLE[name] : 'authenticated';
    expect(grants.map((g) => `${g[1]} -> ${g[2]}`)).toEqual(want ? [`${sig} -> ${want}`] : []);
    const revokeAt = S1.indexOf(`REVOKE ALL ON FUNCTION public.${name}(${sig})`);
    expect(revokeAt).toBeGreaterThan(S1.indexOf(statement(S1, name)));
    if (want) expect(S1.indexOf(`GRANT EXECUTE ON FUNCTION public.${name}(${sig})`)).toBeGreaterThan(revokeAt);
    expect(S1).not.toMatch(new RegExp(`GRANT [A-Z, ]+ ON FUNCTION public\\.${name}\\([^)]*\\) TO [^;]*\\b(anon|PUBLIC)\\b`));
  });

  it.each(fnNames.filter((n) => n !== '_cloud_install_inactive'))('%s: SECURITY DEFINER with search_path empty and a caller check inside', (name) => {
    const st = statement(S1, name);
    expect(st).toMatch(/SECURITY DEFINER SET search_path = ''/);
    const b = body(S1, name);
    if (ROLE[name] === 'service_role') expect(b).toContain("IF auth.role() IS DISTINCT FROM 'service_role' THEN");
    else if (name === 'get_my_cloud_autosave_state') expect(b).toContain("IF v_uid IS NULL THEN RAISE EXCEPTION 'not signed in'");
    else expect(b).toContain("IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object(");
  });

  it('condition 4: each new table has RLS on, no policy, ALL revoked from every API role and TRUNCATE revoked', () => {
    const tables = [...S1.matchAll(/^CREATE TABLE IF NOT EXISTS public\.(\w+) \(/gm)].map((m) => m[1]);
    expect(tables).toEqual(['cloud_release_switches', 'cloud_computer_moves', 'cloud_computer_move_notices']);
    for (const t of tables) {
      expect(S1).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(S1).toContain(`REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(S1).toContain(`REVOKE TRUNCATE ON TABLE public.${t} FROM anon, authenticated;`);
      expect(S1).not.toMatch(new RegExp(`GRANT [A-Z, ]+ ON (TABLE )?public\\.${t}\\b`));
      expect(S1).not.toMatch(new RegExp(`CREATE POLICY [^;]* ON public\\.${t}\\b`));
    }
    expect(S1).toMatch(/one_computer +boolean NOT NULL DEFAULT false,/);
    expect(S1).toMatch(/messages_upload boolean NOT NULL DEFAULT false,/);
  });

  it('condition 2: cloud_confirm_blob locks the settings row FOR SHARE before its gate and before any blob row', () => {
    const b = body(S1, 'cloud_confirm_blob');
    const lock = b.indexOf('FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;');
    expect(lock).toBeGreaterThan(0);
    expect(b.indexOf('/*GATE:active:confirm*/')).toBeGreaterThan(lock);
    expect(b.indexOf('FROM public.cloud_blobs')).toBeGreaterThan(b.indexOf('/*GATE:active:confirm*/'));
    const r = body(S1, 'cloud_register_blob');
    expect(r.indexOf('/*GATE:active:register*/')).toBeGreaterThan(r.indexOf('FOR SHARE;'));
    expect(r.indexOf('INSERT INTO public.cloud_blobs')).toBeGreaterThan(r.indexOf('/*GATE:active:register*/'));
  });

  it('blob functions: old signatures dropped; new bodies = 20261112190000 bodies + the install check, lock and gate', () => {
    expect(S1).toContain('DROP FUNCTION IF EXISTS public.cloud_register_blob(uuid, text, bigint, text);');
    expect(S1).toContain('DROP FUNCTION IF EXISTS public.cloud_confirm_blob(uuid, uuid);');
    const who = (n: string): string =>
      `  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:${n}*/\n`;
    const need = "  IF p_source_install_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;\n";
    const lock = 'PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;';
    const gateOf = (n: string): string =>
      `  IF public._cloud_install_inactive(v_uid, p_source_install_id) THEN                           /*GATE:active:${n}*/\n` +
      "    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');\n  END IF;\n";
    const reg: Spec = {
      head: body(M1, 'cloud_register_blob'), pin: 'none',
      inserts: [
        { anchor: '\nDECLARE v_uid uuid := auth.uid(); b record;', where: 'before', block: '\n/*BODY:4263-s1*/' },
        { anchor: who('register'), where: 'after', block: need },
        { anchor: `  ${lock}\n`, where: 'after', block: '' },
        { anchor: "    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');\n  END IF;\n", where: 'after', block: gateOf('register') },
      ],
    };
    const con: Spec = {
      head: body(M1, 'cloud_confirm_blob'), pin: 'none',
      inserts: [
        { anchor: '\nDECLARE v_uid uuid := auth.uid(); b record;', where: 'before', block: '\n/*BODY:4263-s1*/' },
        { anchor: who('confirm'), where: 'after', block: need + `  ${lock}\n` + gateOf('confirm') },
      ],
    };
    const unmark = (b: string): string => b.replace(/(FOR SHARE;) +\/\*LOCK:(register|confirm)\*\//g, '$1');
    expect(unmark(body(S1, 'cloud_register_blob'))).toBe(derive(reg));
    expect(unmark(body(S1, 'cloud_confirm_blob'))).toBe(derive(con));
  });

  it('condition 6: the state answer stays STABLE and writes nothing', () => {
    const st = statement(S1, 'get_my_cloud_autosave_state');
    expect(st).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    const b = body(S1, 'get_my_cloud_autosave_state');
    expect(b).not.toMatch(/\b(INSERT|UPDATE|DELETE|PERFORM|FOR UPDATE|FOR SHARE|nextval|set_config)\b/i);
    expect(b).toContain("'schema_version', 1,");
    const g = body(S1, '_cloud_install_inactive');
    expect(statement(S1, '_cloud_install_inactive')).toMatch(/LANGUAGE plpgsql STABLE SET search_path = ''/);
    expect(g).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('the gate refuses a NULL active computer while the switch is on (IS DISTINCT FROM, not <>)', () => {
    const g = body(S1, '_cloud_install_inactive');
    expect(g).toMatch(/IS DISTINCT FROM p_install;/);
    expect(g).not.toMatch(/<>/);
    expect(g).toMatch(/coalesce\(\(SELECT w\.one_computer FROM public\.cloud_release_switches w WHERE w\.id\), false\)/);
  });

  it('condition 7: the claim switches the active computer and writes move rows only; it scrubs nothing', () => {
    const b = body(S1, 'cloud_claim_install');
    const writes = [...b.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.(\w+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect([...new Set(writes)].sort()).toEqual(
      [
        'DELETE FROM cloud_removed_installs', 'INSERT INTO cloud_autosave_settings', 'INSERT INTO cloud_computer_move_notices',
        'INSERT INTO cloud_computer_moves', 'UPDATE cloud_autosave_settings',
      ].sort(),
    );
    expect(b).not.toMatch(/cloud_deal_messages|cloud_deal_files|cloud_blobs|cloud_deals\b|_cloud_fence_unreferenced/);
  });

  it('condition 3: move rows only while one_computer is on and the computer changed; replace limited to one per minute', () => {
    const b = body(S1, 'cloud_claim_install');
    const rec = b.indexOf('IF v_on THEN');
    expect(rec).toBeGreaterThan(0);
    expect(b.indexOf('INSERT INTO public.cloud_computer_moves')).toBeGreaterThan(rec);
    expect(b.indexOf('INSERT INTO public.cloud_computer_move_notices')).toBeGreaterThan(rec);
    // the two early returns (same computer; first computer) come before any move row
    expect(b.indexOf('/*CLAIM:same*/')).toBeLessThan(rec);
    expect(b.indexOf('/*CLAIM:first*/')).toBeLessThan(rec);
    expect(b).toMatch(/m\.moved_at > now\(\) - interval '1 minute'\) THEN {3}\/\*CLAIM:rate\*\/\n {4}RETURN jsonb_build_object\('ok', false, 'error', 'busy'\);/);
    expect(b.indexOf('/*CLAIM:rate*/')).toBeLessThan(b.indexOf('/*CLAIM:move_active*/'));
    expect(b.indexOf('/*CLAIM:lock*/')).toBeLessThan(b.indexOf('/*CLAIM:entitled*/'));
  });

  it('condition 8: the turn-off refusal applies only while the caller is licensed, and sits before any delete', () => {
    const b = body(S1, 'set_my_cloud_autosave');
    expect(b).toContain('AND (SELECT l.licensed FROM public._cloud_autosave_license(v_uid) l) IS TRUE THEN');
    const refuse = b.indexOf('/*SET:active:switch*/');
    expect(refuse).toBeGreaterThan(b.indexOf('FOR UPDATE;'));
    expect(refuse).toBeGreaterThan(b.indexOf("RETURN jsonb_build_object('success', true, 'enabled', true);"));
    expect(refuse).toBeLessThan(b.indexOf('/*SET:delete*/'));
    expect(b.indexOf('/*SET:active:clear*/')).toBeLessThan(b.indexOf('EXCEPTION WHEN OTHERS THEN'));
  });

  it('existing rows: Keepr Cloud on, no active computer -> the most recently saving live install, ties to the lowest id', () => {
    const blk = S1.slice(S1.indexOf('DO $backfill4263s1$'), S1.indexOf('$backfill4263s1$;'));
    expect(blk).toContain('WHERE d.removed_at IS NULL');
    expect(blk).toContain('ORDER BY d.owner_user_id, max(d.last_synced_at) DESC, d.source_install_id) w');
    expect(blk).toContain('WHERE s.user_id = w.owner_user_id AND s.enabled AND s.active_install_id IS NULL;');
    // it runs after the columns exist, and the ALTER comes after every function
    const alter = S1.indexOf('ALTER TABLE public.cloud_autosave_settings\n  ADD COLUMN IF NOT EXISTS active_install_id uuid NULL,');
    expect(alter).toBeGreaterThan(S1.lastIndexOf('$f$;'));
    expect(S1.indexOf('DO $backfill4263s1$')).toBeGreaterThan(alter);
  });

  it('pre-check refuses when neither the earlier nor the new signature is present (no NULL pass-through)', () => {
    const pre = S1.slice(S1.indexOf('DO $pre4263s1$'), S1.indexOf('$pre4263s1$;'));
    expect(pre).toContain('    IF ((v = r.head AND w IS NULL) OR (v IS NULL AND w = r.mine)) IS NOT TRUE THEN\n');
    expect(pre).toContain('    IF v IS NULL OR v NOT IN (r.head, r.mine) THEN\n');
  });

  it('pre-check first, then lock_timeout 3s, before any change', () => {
    expect(S1.indexOf('DO $pre4263s1$')).toBeLessThan(S1.indexOf("SET LOCAL lock_timeout = '3s';"));
    expect(S1.indexOf("SET LOCAL lock_timeout = '3s';")).toBeLessThan(S1.indexOf('\nCREATE TABLE'));
    const firstChange = S1.search(/^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REVOKE|GRANT)\b/m);
    expect(firstChange).toBeGreaterThan(S1.indexOf("SET LOCAL lock_timeout = '3s';"));
  });

  it('no literal UUID and no email address', () => {
    expect(S1).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(S1).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
  });
});

describe('BACKLOG-4263 S1 one computer: rollback file and test-project harness agree with the migration', () => {
  const DIR = join(REPO, 'supabase/tests/backlog-4263-sync2-s1');
  const RB = read(join(DIR, 'rollback-20261123100000.sql'));
  const HARNESS = read(join(DIR, 'harness-s1.sql'));
  const HEADS: Array<[string, string]> = [
    ...WRITERS.map((w) => [w[0], w[1]] as [string, string]),
    ['get_my_cloud_autosave_state', M1], ['set_my_cloud_autosave', M2], ['cloud_register_blob', M1], ['cloud_confirm_blob', M1],
  ];

  it.each(HEADS)('rollback puts back %s exactly as its head migration wrote it', (name, text) => {
    const st = statement(text, name);
    expect(count(RB, st)).toBe(1);
    expect(body(RB, name)).toBe(body(text, name));
    // the REVOKE / GRANT lines that follow the statement in the head file follow it in the rollback too
    const after = text.slice(text.indexOf(st) + st.length + 1).split('\n');
    const grants = after.slice(0, after.findIndex((l) => !/^(REVOKE|GRANT) /.test(l)));
    expect(grants.length).toBeGreaterThanOrEqual(1);
    expect(RB).toContain(`${st}\n${grants.join('\n')}\n`);
  });

  it('rollback drops what S1 created and checks S1 is in place first', () => {
    for (const d of [
      'DROP FUNCTION IF EXISTS public.set_my_cloud_autosave(uuid, boolean, integer, uuid);',
      'DROP FUNCTION IF EXISTS public.cloud_register_blob(uuid, uuid, text, bigint, text);',
      'DROP FUNCTION IF EXISTS public.cloud_confirm_blob(uuid, uuid, uuid);',
      'DROP FUNCTION IF EXISTS public.cloud_claim_install(uuid, uuid, boolean);',
      'DROP FUNCTION IF EXISTS public._cloud_install_inactive(uuid, uuid);',
      'DROP TABLE IF EXISTS public.cloud_computer_move_notices;',
      'DROP TABLE IF EXISTS public.cloud_release_switches;',
      'ALTER TABLE public.cloud_autosave_settings DROP COLUMN IF EXISTS active_install_id, DROP COLUMN IF EXISTS active_since;',
      "DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261123100000';",
    ]) expect(RB).toContain(d);
    const pre = RB.slice(0, RB.indexOf('$prerb4263s1$;'));
    for (const name of ['cloud_claim_install', 'cloud_upsert_deal', 'set_my_cloud_autosave', 'cloud_confirm_blob']) {
      expect(pre).toContain(`'${md5(body(S1, name))}'`);
    }
    expect(RB.search(/^(CREATE|DROP|ALTER|DELETE)\b/m)).toBeGreaterThan(RB.indexOf('$prerb4263s1$;'));
  });

  it('harness: guard first, built from this migration text, the rollback verbatim, no other DDL on existing tables', () => {
    const lines = HARNESS.split('\n');
    expect(lines[1]).toContain('must never be run on production');
    expect(HARNESS.replace(/^--[^\n]*\n/gm, '').startsWith('DO $guard4263s1$')).toBe(true);
    expect(HARNESS).toContain(`(file md5 ${md5(S1)})`);
    expect(HARNESS).toContain(RB);
    const outside = HARNESS.replace(RB, '');
    expect(outside).not.toMatch(/^\s*(ALTER TABLE|DROP TABLE|TRUNCATE|LOCK TABLE)\b/im);
    expect(outside).toContain("RAISE EXCEPTION 'S1_RESULT %'");
    expect(HARNESS).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{11}[1-9a-f]/i);
  });

  it('harness backfill fixture: bf_7 tells the real ordering (greatest max save) apart from greatest min save', () => {
    // the rule as the migration writes it
    expect(S1).toContain('ORDER BY d.owner_user_id, max(d.last_synced_at) DESC, d.source_install_id) w');
    // install ids exactly as the harness's pg_temp.fx() makes them; uuid order is byte order = hex text order
    const fx = (k: string): string => md5(`p4263:sync2-s1-harness:${k}`);
    const rowRe = /\(pg_temp\.f\('bf_7'\), pg_temp\.f\('(bf_7_i\d)'\), '[^']+', pg_temp\.h\('[^']+'\), now\(\) - interval '(\d+) hours', NULL\)/g;
    const ago = new Map<string, number[]>();
    for (const m of HARNESS.matchAll(rowRe)) ago.set(m[1], [...(ago.get(m[1]) ?? []), Number(m[2])]);
    const installs = [...ago.keys()];
    expect(installs.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...[...ago.values()].map((a) => a.length))).toBeGreaterThanOrEqual(2);
    // fewer hours ago = saved later; ties to the lowest id
    const pick = (score: (k: string) => number): string =>
      [...installs].sort((a, b) => score(b) - score(a) || (fx(a) < fx(b) ? -1 : 1))[0];
    const maxSave = (k: string): number => -Math.min(...ago.get(k)!);
    const minSave = (k: string): number => -Math.max(...ago.get(k)!);
    const real = pick(maxSave);
    expect(pick(minSave)).not.toBe(real); // min(...) DESC, the harness's M_backfill_least_recent
    expect(pick((k) => -maxSave(k))).not.toBe(real); // max(...) ASC
    expect(pick((k) => -minSave(k))).not.toBe(real); // min(...) ASC
    expect(pick(() => 0)).not.toBe(real); // install id only
    const asserted = /'max_not_min', \(SELECT active_install_id FROM public\.cloud_autosave_settings WHERE user_id = pg_temp\.f\('bf_7'\)\) = pg_temp\.f\('(bf_7_i\d)'\)\)/.exec(HARNESS);
    expect(asserted?.[1]).toBe(real);
    expect(HARNESS).toContain("UPDATE pg_temp.s1_sql SET s = replace(s, 'max(d.last_synced_at) DESC', 'min(d.last_synced_at) DESC') WHERE k = 'backfill';");
  });

  it('harness backfill fixture: bf_2 is a tie on the most recent save, decided by the install id term', () => {
    const fx = (k: string): string => md5(`p4263:sync2-s1-harness:${k}`);
    const rowRe = /\(pg_temp\.f\('bf_2'\), pg_temp\.f\('(bf_2_i\d)'\), '[^']+', pg_temp\.h\('[^']+'\), timestamptz '([^']+)', NULL\)/g;
    const rows = [...HARNESS.matchAll(rowRe)].map((m) => ({ inst: m[1], at: m[2] }));
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.inst)).size).toBe(2);
    expect(rows[0].at).toBe(rows[1].at); // same save time on both installs: only the id term decides
    const asc = [...rows].sort((a, b) => (fx(a.inst) < fx(b.inst) ? -1 : 1))[0].inst;
    const desc = [...rows].sort((a, b) => (fx(a.inst) < fx(b.inst) ? 1 : -1))[0].inst;
    expect(asc).not.toBe(desc); // the migration (ascending) and the mutant (descending) pick different installs
    expect(HARNESS).toContain("= least(pg_temp.f('bf_2_i1'), pg_temp.f('bf_2_i2'))");
    expect(HARNESS).toContain("UPDATE pg_temp.s1_sql SET s = replace(s, 'd.source_install_id) w', 'd.source_install_id DESC) w') WHERE k = 'backfill';");
    expect(HARNESS).toContain('-- M_backfill_tie_highest (primary control c2b_backfill)');
  });

  const caseBody = (name: string): string => {
    const at = HARNESS.indexOf(`CREATE FUNCTION pg_temp.${name}() RETURNS text`);
    expect(at).toBeGreaterThan(0);
    return HARNESS.slice(at, HARNESS.indexOf('END $c$;', at));
  };

  it('harness c1_push: the inactive call carries a real op, checked against the fingerprint taken just before it', () => {
    const b = caseBody('c1_push');
    const before = b.indexOf('before := pg_temp.fp();');
    const inactive = b.indexOf("pg_temp.clop(pg_temp.f('dB'), 'c1-cl-IB')");
    expect(before).toBeGreaterThan(0);
    expect(inactive).toBeGreaterThan(before);
    expect(b.indexOf('after := pg_temp.fp();')).toBeGreaterThan(inactive);
    expect(b).toContain("(ra -> 'results' -> 0 ->> 'status') = 'added'");
    expect(HARNESS).toMatch(/CREATE FUNCTION pg_temp\.clop\(deal uuid, lid text\)[\s\S]{0,200}'kind', 'create_checklist'/);
    // the fingerprint covers what the op writes
    expect(HARNESS).toMatch(/CREATE FUNCTION pg_temp\.fp\(\)[\s\S]*FROM public\.cloud_todo_ops o[\s\S]*FROM public\.cloud_deal_checklists c/);
    // wrong implementation: answer computer_not_active only after the ops were applied
    const m = HARNESS.slice(HARNESS.indexOf('-- M_push_gate_after_write (primary control c1_push)'));
    const mut = m.slice(0, m.indexOf('\n  -- M_', 10));
    expect(mut.indexOf('v_res := public._cloud_todo_apply(')).toBeGreaterThan(0);
    expect(mut.indexOf('/*GATE:active:push*/')).toBeGreaterThan(mut.indexOf('v_res := public._cloud_todo_apply('));
  });

  it('harness c1_confirm: bA has its storage object first, so the inactive confirm would write without the gate', () => {
    const b = caseBody('c1_confirm');
    const obj = b.indexOf("INSERT INTO storage.objects (bucket_id, name, metadata)\n  SELECT 'cloud-deal-files', b.storage_path, jsonb_build_object('size', b.size_bytes::text) FROM public.cloud_blobs b WHERE b.id = pg_temp.f('bA');");
    expect(obj).toBeGreaterThan(0);
    expect(b.indexOf('before := pg_temp.fp();')).toBeGreaterThan(obj);
    expect(b).toContain("(ra ->> 'ok') = 'true' AND (ra ->> 'state') = 'uploaded'");
    expect(HARNESS).toMatch(/CREATE FUNCTION pg_temp\.fp\(\)[\s\S]*b\.uploaded_at, b\.purge_requested_at/);
  });

  it('harness c2_same: active_since is set to a fixed earlier time before the repeated claim', () => {
    const b = caseBody('c2_same');
    const set = b.indexOf("UPDATE public.cloud_autosave_settings SET active_since = timestamptz '2026-01-01 00:00:00+00' WHERE user_id = pg_temp.f('A');");
    expect(set).toBeGreaterThan(0);
    expect(b.indexOf("x_t := timestamptz '2026-01-01 00:00:00+00';")).toBeGreaterThan(set);
    expect(b.indexOf("v := pg_temp.claim('IA', true);")).toBeGreaterThan(set);
    expect(b).toContain("WHERE user_id = pg_temp.f('A')) = x_t");
  });

  const MUTANTS: Array<[string, string, string]> = [
    ['mutant-claim-nolock.sql', 'cloud_claim_install', 'uuid, uuid, boolean'],
    ['mutant-confirm-nolock.sql', 'cloud_confirm_blob', 'uuid, uuid, uuid'],
    ['mutant-off-check-before-lock.sql', 'set_my_cloud_autosave', 'uuid, boolean, integer, uuid'],
    ['mutant-deal-gate-before-lock.sql', 'cloud_upsert_deal', 'uuid, jsonb'],
  ];
  it.each(MUTANTS)('two-session %s creates only %s_m4263, never replaces the live function, guard first', (file, name, sig) => {
    const f = read(join(DIR, 'concurrency', file));
    const code = f.replace(/^--[^\n]*\n/gm, '');
    expect(code.startsWith('DO $guard4263s1cc$')).toBe(true);
    expect(f).not.toMatch(new RegExp(`FUNCTION public\\.${name}\\(`));
    expect([...f.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/gm)].map((m) => m[1])).toEqual([`${name}_m4263`]);
    expect(f).not.toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(f).toContain(`REVOKE ALL ON FUNCTION public.${name}_m4263(${sig}) FROM PUBLIC, anon, authenticated, service_role;`);
    expect([...f.matchAll(/^GRANT [^\n]*$/gm)].map((m) => m[0])).toEqual([`GRANT EXECUTE ON FUNCTION public.${name}_m4263(${sig}) TO authenticated;`]);
    expect(read(join(DIR, 'concurrency/drop-mutants.sql'))).toContain(`DROP FUNCTION IF EXISTS public.${name}_m4263(${sig});`);
    expect(body(f.replace(`public.${name}_m4263(`, `public.${name}(`), name)).not.toBe(body(S1, name));
  });

  it('two-session R4 mutant keeps the refusal and reads the active computer before the settings lock (red only under the race)', () => {
    const f = read(join(DIR, 'concurrency/mutant-off-check-before-lock.sql'));
    const b = f.slice(f.indexOf('CREATE FUNCTION public.set_my_cloud_autosave_m4263('));
    const check = b.indexOf("      RETURN jsonb_build_object('success', false, 'error', 'computer_not_active');");
    const lock = b.indexOf('  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR UPDATE;');
    expect(check).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(check);
    expect(b.indexOf('/*SET:active:switch*/', lock)).toBe(-1);
    expect(b).not.toMatch(/^\s*NULL;\s*$/m);
  });

  it('two-session hold marker is the first line of the session-1 call and no session file carries it inline', () => {
    const cc = join(DIR, 'concurrency');
    expect(read(join(cc, 'hold-marker.sql')).startsWith('/*p_hold:__RUN__*/\n')).toBe(true);
    for (const f of readdirSync(cc).filter((x) => /^(r\d-|claim-|end)/.test(x))) {
      expect(`${f}: ${read(join(cc, f)).includes('p_hold:')}`).toBe(`${f}: false`);
    }
    const run = read(join(cc, 'run.sh'));
    expect(run).toContain('{ cat "$here/hold-marker.sql"; cat "$here/guard.sql"; echo;');
    expect(readdirSync(cc)).not.toContain('sweep.sql');
  });

  it('two-session session files call functions only through placeholders, and no pristine replacement file remains', () => {
    const cc = join(DIR, 'concurrency');
    const files = readdirSync(cc);
    expect(files.filter((f) => f.startsWith('pristine-'))).toEqual([]);
    for (const f of files.filter((x) => /^(r\d-|claim-)/.test(x))) {
      expect(`${f}: ${/public\.(cloud_claim_install|cloud_confirm_blob|set_my_cloud_autosave|cloud_upsert_deal)\(/.test(read(join(cc, f)))}`).toBe(`${f}: false`);
    }
    const run = read(join(cc, 'run.sh'));
    expect(run).toContain('No claim-side mutant: without FOR UPDATE the claim still waits at its UPDATE');
    expect(run).toContain('refusing to start');
    expect(read(join(cc, 'setup.sql')).length).toBeGreaterThan(0);
  });

  it('harness refuses its rollback step unless it runs as one transaction: first statement of the rollback block, outside its handler', () => {
    const blk = HARNESS.indexOf('DO $rb4263s1$\nBEGIN\n');
    const chk = HARNESS.indexOf("  IF to_regclass('pg_temp.s1_out') IS NULL THEN\n    RAISE EXCEPTION");
    expect(blk).toBeGreaterThan(0);
    expect(chk).toBe(blk + 'DO $rb4263s1$\nBEGIN\n'.length);
    expect(HARNESS.indexOf('EXECUTE $rbq$', chk)).toBeGreaterThan(chk);
    expect(HARNESS.indexOf('  BEGIN\n    EXECUTE $rbq$', chk)).toBeGreaterThan(chk);
  });

  it('two-session run.sh: verdict starts as ERROR, the mutant is proven applied and still present, verdict from verdict.py', () => {
    const run = read(join(DIR, 'concurrency/run.sh'));
    expect(run).toMatch(/\bVERDICT=ERROR\b/);
    expect(run).not.toMatch(/\bVERDICT=FAIL\b/);
    expect(run).toContain('applied="$(mutant_md5 applied.out)" || { VERDICT="ERROR: ${applied}"; exit 1; }');
    expect(run).toContain('echo "$applied"');
    expect(run).toContain('still="$(mutant_md5 still.out)" ||');
    expect(run).toContain('python3 -I "$here/verdict.py" applied');
    expect(run).toContain('case "$MODE:$VERDICT" in pristine:PASS|mutant:RED) ;; *) rc=1 ;; esac');
    expect(run).toContain('VERDICT="$(python3 -I "$here/verdict.py" "$CASE" "$MODE"');
    const v = read(join(DIR, 'concurrency/verdict.py'));
    expect(v).toContain("return f'MUTATION APPLIED {name} md5 {m}'");
    expect(read(join(DIR, 'concurrency/setup.sql'))).toContain("IF EXISTS (SELECT 1 FROM auth.users u WHERE u.email LIKE 'p4263s1cc-%@example.test') THEN");
  });
});

