/**
 * BACKLOG-4263 (sync 2.49, P4): static checks of migration 20261123130000_backlog_4263_messages_up_server.sql (S2).
 *
 * C-0: every replaced body is re-derived here from the earlier migration text (20261123100000 for four functions,
 * 20261118120000 for cloud_list_install_rows) by applying named insert templates at named anchors, and must equal the
 * body in the S2 file byte for byte. The earlier text is tied to the database by the md5 pins in
 * supabase/tests/backlog-4263-prod/postcheck-20261123100000.sql and postcheck-final.sql.
 *
 * CI has no database: what the SQL does when it runs is checked by supabase/tests/backlog-4263-sync2-s2/ on the test
 * project.
 */

import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIG = join(REPO, 'supabase/migrations');
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

const S2_FILE = '20261123130000_backlog_4263_messages_up_server.sql';
const S2_PATH = `supabase/migrations/${S2_FILE}`;
const M3 = read(join(MIG, '20261118120000_backlog_4263_todo_old_item_path_removed.sql'));
const S1 = read(join(MIG, '20261123100000_backlog_4263_one_computer.sql'));
const S2 = read(join(MIG, S2_FILE));
const PROD = join(REPO, 'supabase/tests/backlog-4263-prod');
const PIN_FILES = { s1: read(join(PROD, 'postcheck-20261123100000.sql')), final: read(join(PROD, 'postcheck-final.sql')) };

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
const header = (sql: string, name: string): string => {
  const st = statement(sql, name);
  return st.slice(0, st.indexOf(body(sql, name)));
};
const count = (s: string, sub: string): number => s.split(sub).length - 1;
const pins = (pc: string): Map<string, string> =>
  new Map([...pc.matchAll(/^ {4}\('public\.(\w+)\([^)]*\)', '([0-9a-f]{32})',/gm)].map((m) => [m[1], m[2]] as [string, string]));

type Insert = { anchor: string; where: 'before' | 'after'; block: string };
type Spec = { head: string; pin: 's1' | 'final'; sig: string; inserts: Insert[] };

/** The 3-line IF ... END IF block carrying /*GATE:active:<short>*\/ (the anchor the switch check goes after). */
function activeGate(b: string, short: string): string {
  const m = new RegExp(`^.*/\\*GATE:active:${short}\\*/\\n.*\\n  END IF;\\n`, 'm').exec(b);
  if (!m) throw new Error(`${short}: active gate not found`);
  return m[0];
}
function uploadGate(short: string): string {
  return (
    '  IF coalesce((SELECT w.messages_upload FROM public.cloud_release_switches w WHERE w.id), false) IS NOT TRUE THEN'.padEnd(118) +
    ` /*GATE:upload:${short}*/\n` +
    "    RETURN jsonb_build_object('ok', false, 'error', 'feature_off');\n" +
    '  END IF;\n'
  );
}
const NOQUEUE: Insert = {
  anchor: "    IF v_kind = 'text' AND r ->> 'thread_key' IS NULL THEN\n",
  where: 'before',
  block:
    "    IF coalesce(r ->> 'link_origin', 'link') = 'review_queue' THEN".padEnd(93) +
    ' /*MSG:noqueue*/\n' +
    "      out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'review_queue_not_accepted');\n" +
    '      CONTINUE;\n' +
    '    END IF;\n',
};
const TOMB_FILES: Insert = {
  anchor:
    '             subject = NULL, body_text = NULL, body_truncated = false, participants = NULL          /*TOMB:scrub*/\n' +
    '       WHERE id = v_row_id RETURNING version INTO v_row_version;\n',
  where: 'after',
  block: `      -- the message's live file rows are removed in the same call, as kind 'file' removes them; their blobs are fenced below
      SELECT v_fence || coalesce(array_agg(x.blob_id ORDER BY x.id) FILTER (WHERE x.blob_id IS NOT NULL), '{}')
        INTO v_fence
        FROM (SELECT f.id, f.blob_id FROM public.cloud_deal_files f
               WHERE f.cloud_message_id = v_row_id AND f.cloud_deal_id = v_row_deal AND f.owner_user_id = v_uid
                 AND f.removed_at IS NULL
               ORDER BY f.id FOR UPDATE) x;                                                     /*TOMB:msgfiles:lock*/
      UPDATE public.cloud_deal_files f SET removed_at = now(), version = f.version + 1, updated_at = now(),
             filename = NULL, blob_id = NULL
       WHERE f.cloud_message_id = v_row_id AND f.cloud_deal_id = v_row_deal AND f.owner_user_id = v_uid
         AND f.removed_at IS NULL;                                                              /*TOMB:msgfiles*/
`,
};
const LIST_KINDS: Insert = {
  anchor:
    "      ('party',          'cloud_deal_parties',         'local_party_id',       't.cloud_deal_id', 't.removed_at IS NOT NULL OR d.removed_at IS NOT NULL')\n",
  where: 'after',
  block:
    "      ,('message',       'cloud_deal_messages',        'local_message_id',     't.cloud_deal_id', 't.removed_at IS NOT NULL OR d.removed_at IS NOT NULL')  /*LIST:message*/\n" +
    "      ,('file',          'cloud_deal_files',           'local_attachment_id',  't.cloud_deal_id', 't.removed_at IS NOT NULL OR d.removed_at IS NOT NULL')  /*LIST:file*/\n",
};
const LIST_CHANNEL: Insert = {
  anchor: '    INTO v_rows, v_n, v_last USING v_uid, p_source_install_id, p_after, v_limit;\n',
  where: 'after',
  block: `  IF p_kind = 'message' THEN                                                                  /*LIST:channel_kind*/
    SELECT coalesce(jsonb_agg(e.value || jsonb_build_object('channel_kind', m.channel_kind) ORDER BY e.n), '[]'::jsonb)
      INTO v_rows
      FROM jsonb_array_elements(v_rows) WITH ORDINALITY e(value, n)
      LEFT JOIN public.cloud_deal_messages m ON m.id = (e.value ->> 'cloud_id')::uuid;
  END IF;
`,
};

const SPECS: Record<string, Spec> = {
  cloud_upsert_messages: {
    head: body(S1, 'cloud_upsert_messages'), pin: 's1', sig: 'uuid, uuid, uuid, jsonb',
    inserts: [{ anchor: activeGate(body(S1, 'cloud_upsert_messages'), 'messages'), where: 'after', block: uploadGate('messages') }, NOQUEUE],
  },
  cloud_upsert_files: {
    head: body(S1, 'cloud_upsert_files'), pin: 's1', sig: 'uuid, uuid, uuid, jsonb',
    inserts: [{ anchor: activeGate(body(S1, 'cloud_upsert_files'), 'files'), where: 'after', block: uploadGate('files') }],
  },
  cloud_register_blob: {
    head: body(S1, 'cloud_register_blob'), pin: 's1', sig: 'uuid, uuid, text, bigint, text',
    inserts: [{ anchor: activeGate(body(S1, 'cloud_register_blob'), 'register'), where: 'after', block: uploadGate('register') }],
  },
  cloud_tombstone: { head: body(S1, 'cloud_tombstone'), pin: 's1', sig: 'uuid, uuid, text, uuid[]', inserts: [TOMB_FILES] },
  cloud_list_install_rows: {
    head: body(M3, 'cloud_list_install_rows'), pin: 'final', sig: 'uuid, uuid, text, uuid, integer', inserts: [LIST_KINDS, LIST_CHANNEL],
  },
};
const HEAD_SQL: Record<string, string> = {
  cloud_upsert_messages: S1, cloud_upsert_files: S1, cloud_register_blob: S1, cloud_tombstone: S1, cloud_list_install_rows: M3,
};
const NAMES = Object.keys(SPECS);

function derive(spec: Spec): string {
  let out = spec.head;
  for (const ins of spec.inserts) {
    expect(count(out, ins.anchor)).toBe(1);
    const i = out.indexOf(ins.anchor) + (ins.where === 'after' ? ins.anchor.length : 0);
    out = out.slice(0, i) + ins.block + out.slice(i);
  }
  return out;
}

describe('BACKLOG-4263 S2 messages up: C-0 replaced bodies', () => {
  it('the file is the only migration at its version', () => {
    expect(readdirSync(MIG).filter((f) => f.startsWith('20261123130000'))).toEqual([S2_FILE]);
  });

  it.each(NAMES)('%s: the earlier text is the body the database holds before S2 (md5 pin)', (name) => {
    const want = pins(PIN_FILES[SPECS[name].pin]).get(name);
    expect(want).toMatch(/^[0-9a-f]{32}$/);
    expect(`${name} ${md5(SPECS[name].head)}`).toBe(`${name} ${want}`);
  });

  it.each(NAMES)('%s: S2 body = earlier body + the named inserts, byte for byte', (name) => {
    const got = body(S2, name);
    expect(got.length).toBeGreaterThan(SPECS[name].head.length);
    expect(got).toBe(derive(SPECS[name]));
  });

  it.each(NAMES)('%s: header line unchanged from the earlier definition', (name) => {
    expect(header(S2, name)).toBe(header(HEAD_SQL[name], name));
  });

  it.each(NAMES)("%s: the pre-check accepts exactly the earlier body and this file's body", (name) => {
    const pre = S2.slice(S2.indexOf('DO $pre4263s2$'), S2.indexOf('$pre4263s2$;'));
    expect(pre).toContain(`      ('public.${name}(${SPECS[name].sig.replace(/ /g, '')})', '${md5(SPECS[name].head)}', '${md5(body(S2, name))}')`);
    expect(pre).toContain('    IF v IS NULL OR v NOT IN (r.head, r.mine) THEN\n');
  });

  it.each(NAMES)("%s: the post-check pins this file's body", (name) => {
    const post = S2.slice(S2.indexOf('DO $post4263s2$'), S2.indexOf('$post4263s2$;'));
    expect(post).toContain(`'${md5(body(S2, name))}'`);
  });
});

describe('BACKLOG-4263 S2 messages up: acceptance conditions readable from the text', () => {
  const fnNames = [...S2.matchAll(/^CREATE OR REPLACE FUNCTION public\.(\w+)\(/gm)].map((m) => m[1]);

  it('replaces exactly the five functions, each once; no table, column, index, policy or drop', () => {
    expect([...fnNames].sort()).toEqual(
      ['cloud_list_install_rows', 'cloud_register_blob', 'cloud_tombstone', 'cloud_upsert_files', 'cloud_upsert_messages'],
    );
    // top-level statements only: comments and every dollar-quoted body (functions, DO blocks) removed
    const code = S2.replace(/^--[^\n]*\n/gm, '').replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '');
    expect(code).toContain('CREATE OR REPLACE FUNCTION public.cloud_tombstone(');
    expect(code).not.toMatch(/^\s*(CREATE (UNIQUE )?(TABLE|INDEX|POLICY|TRIGGER)|ALTER |DROP |TRUNCATE|LOCK |INSERT |UPDATE |DELETE |COMMENT )/im);
    expect(code.match(/^[A-Z]+/gm)!.filter((k) => !['DO', 'SET', 'CREATE', 'REVOKE', 'GRANT', 'LANGUAGE'].includes(k))).toEqual([]);
  });

  it.each(NAMES)('%s: revoked from PUBLIC, anon, authenticated, service_role on the full signature, then granted to authenticated only', (name) => {
    const sig = SPECS[name].sig;
    const st = statement(S2, name);
    const after = S2.slice(S2.indexOf(st) + st.length + 1).split('\n');
    expect(after.slice(0, 2)).toEqual([
      `REVOKE ALL ON FUNCTION public.${name}(${sig}) FROM PUBLIC, anon, authenticated, service_role;`,
      `GRANT EXECUTE ON FUNCTION public.${name}(${sig}) TO authenticated;`,
    ]);
    expect([...S2.matchAll(new RegExp(`^GRANT [^\\n]*public\\.${name}\\(`, 'gm'))]).toHaveLength(1);
    expect(S2).not.toMatch(new RegExp(`GRANT [A-Z, ]+ ON FUNCTION public\\.${name}\\([^)]*\\) TO [^;]*\\b(anon|PUBLIC|service_role)\\b`));
  });

  it.each(NAMES)('%s: SECURITY DEFINER, search_path empty, caller checked first', (name) => {
    expect(header(S2, name)).toMatch(/SECURITY DEFINER SET search_path = ''/);
    const b = body(S2, name);
    const who = b.indexOf('IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object(');
    expect(who).toBeGreaterThan(0);
    expect(b.indexOf('IF v_uid IS NULL THEN RETURN')).toBeLessThan(who);
  });

  it('condition 4 / 11.6: the switch is read only by the three content paths, never by removal or reconcile', () => {
    const readers = NAMES.filter((n) => body(S2, n).includes('messages_upload'));
    expect(readers.sort()).toEqual(['cloud_register_blob', 'cloud_upsert_files', 'cloud_upsert_messages']);
    expect(body(S2, 'cloud_tombstone')).not.toMatch(/messages_upload|feature_off|cloud_release_switches/);
    expect(body(S2, 'cloud_list_install_rows')).not.toMatch(/messages_upload|feature_off|cloud_release_switches/);
    expect(S2).not.toMatch(/FUNCTION public\.cloud_confirm_blob\(/);
  });

  it.each([
    ['cloud_upsert_messages', 'messages'],
    ['cloud_upsert_files', 'files'],
    ['cloud_register_blob', 'register'],
  ])('%s: the switch check sits after the settings lock and the computer gate, before any row is read or written', (name, short) => {
    const b = body(S2, name);
    const lock = b.indexOf('FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;');
    const act = b.indexOf(`/*GATE:active:${short}*/`);
    const up = b.indexOf(`/*GATE:upload:${short}*/`);
    expect(lock).toBeGreaterThan(0);
    expect(act).toBeGreaterThan(lock);
    expect(up).toBeGreaterThan(act);
    const firstRow = Math.min(...['FROM public.cloud_deals', 'INSERT INTO public.cloud_blobs'].map((s) => b.indexOf(s)).filter((i) => i > 0));
    expect(up).toBeLessThan(firstRow);
    expect(count(b, '/*GATE:upload:')).toBe(1);
  });

  it('condition 2: a review-queue row is rejected before its row is inserted; the other rows of the call go on', () => {
    const b = body(S2, 'cloud_upsert_messages');
    const refuse = b.indexOf('/*MSG:noqueue*/');
    expect(refuse).toBeGreaterThan(b.indexOf('/*MSG:values*/'));
    expect(refuse).toBeLessThan(b.indexOf('INSERT INTO public.cloud_deal_messages'));
    expect(b.slice(refuse, b.indexOf('END IF;', refuse))).toContain('CONTINUE;');
  });

  it('condition 3: removing a message removes its live file rows in the same call, after the deal locks, fenced at the end', () => {
    const b = body(S2, 'cloud_tombstone');
    const lockDeals = b.indexOf('/*TOMB:lockdeals*/');
    const arm = b.indexOf("ELSIF p_kind = 'message' THEN");
    const files = b.indexOf('/*TOMB:msgfiles*/');
    expect(lockDeals).toBeGreaterThan(0);
    expect(arm).toBeGreaterThan(lockDeals);
    expect(b.indexOf('/*TOMB:msgfiles:lock*/')).toBeGreaterThan(arm);
    expect(files).toBeGreaterThan(b.indexOf('/*TOMB:msgfiles:lock*/'));
    expect(files).toBeLessThan(b.indexOf('    ELSE\n', arm));
    expect(b.indexOf('/*TOMB:fence*/')).toBeGreaterThan(files);
    // the answer keeps one result per id asked for, with the same keys
    expect(count(b, "out := out || jsonb_build_object('cloud_id', v_id, 'status', 'removed', 'version', v_row_version);")).toBe(1);
  });

  it('reconcile: message and file kinds count a row as removed when it or its deal is removed; channel_kind on message rows only', () => {
    const b = body(S2, 'cloud_list_install_rows');
    expect(b).toContain("('deal',           'cloud_deals',                'local_transaction_id', 't.id',            't.removed_at IS NOT NULL'),");
    expect(b).toMatch(/,\('message', +'cloud_deal_messages', +'local_message_id', +'t\.cloud_deal_id', 't\.removed_at IS NOT NULL OR d\.removed_at IS NOT NULL'\)/);
    expect(b).toMatch(/,\('file', +'cloud_deal_files', +'local_attachment_id', +'t\.cloud_deal_id', 't\.removed_at IS NOT NULL OR d\.removed_at IS NOT NULL'\)/);
    expect(b).toContain("  IF p_kind = 'message' THEN");
    expect(header(S2, 'cloud_list_install_rows')).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    expect(b).not.toMatch(/\b(INSERT|UPDATE|DELETE|FOR UPDATE|FOR SHARE)\b/);
  });

  it('the one-computer gates of 20261123100000 are kept in every replaced writer', () => {
    for (const [name, short] of [
      ['cloud_upsert_messages', 'messages'], ['cloud_upsert_files', 'files'], ['cloud_register_blob', 'register'], ['cloud_tombstone', 'tombstone'],
    ]) {
      expect(body(S2, name)).toContain(activeGate(body(S1, name), short));
    }
  });

  it('pre-check first, then lock_timeout 3s, before any change', () => {
    expect(S2.indexOf('DO $pre4263s2$')).toBeLessThan(S2.indexOf("SET LOCAL lock_timeout = '3s';"));
    const firstChange = S2.search(/^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REVOKE|GRANT)\b/m);
    expect(firstChange).toBeGreaterThan(S2.indexOf("SET LOCAL lock_timeout = '3s';"));
  });

  it('no literal UUID and no email address', () => {
    expect(S2).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(S2).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
  });
});

describe('BACKLOG-4263 S2 messages up: apply, rollback and test-project harness agree with the migration', () => {
  const DIR = join(REPO, 'supabase/tests/backlog-4263-sync2-s2');
  const APPLY = read(join(DIR, 'apply-20261123130000.sql'));
  const RB = read(join(DIR, 'rollback-20261123130000.sql'));
  const HARNESS = read(join(DIR, 'harness-s2.sql'));

  it('apply file: comment lines naming the migration and its md5, the migration text once, then exactly its ledger row', () => {
    expect(APPLY.split(S2)).toHaveLength(2);
    const head = APPLY.slice(0, APPLY.indexOf(S2));
    expect(head.endsWith('\n\n')).toBe(true);
    for (const l of head.replace(/\n\n$/, '').split('\n')) expect(l.startsWith('-- ')).toBe(true);
    expect(head.split('\n')[0]).toMatch(/^-- apply-20261123130000\.sql \(generated by /);
    expect(head).toContain(`-- Migration: ${S2_PATH}  file md5 ${md5(S2)}\n`);
    expect(APPLY.slice(APPLY.indexOf(S2) + S2.length)).toBe(
      "\nINSERT INTO supabase_migrations.schema_migrations (version, name, statements)\nVALUES ('20261123130000', 'backlog_4263_messages_up_server', ARRAY[]::text[]);\n",
    );
  });

  it.each(NAMES)('rollback puts back %s exactly as the earlier migration wrote it, with its grants', (name) => {
    const text = HEAD_SQL[name];
    const st = statement(text, name);
    expect(count(RB, st)).toBe(1);
    const after = text.slice(text.indexOf(st) + st.length + 1).split('\n');
    const grants = after.slice(0, after.findIndex((l) => !/^(REVOKE|GRANT) /.test(l)));
    expect(grants.length).toBeGreaterThanOrEqual(2);
    expect(RB).toContain(`${st}\n${grants.join('\n')}\n`);
  });

  it('rollback checks S2 is in place first, removes only the ledger row besides the bodies, and post-checks', () => {
    const pre = RB.slice(0, RB.indexOf('$prerb4263s2$;'));
    for (const name of NAMES) expect(pre).toContain(`'${md5(body(S2, name))}'`);
    expect(RB.search(/^(CREATE|DROP|ALTER|DELETE)\b/m)).toBeGreaterThan(RB.indexOf('$prerb4263s2$;'));
    expect(RB).toContain("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261123130000';");
    expect(RB.replace(/^--[^\n]*\n/gm, '')).not.toMatch(/^\s*(DROP|ALTER TABLE|TRUNCATE|LOCK TABLE)\b/im);
    const post = RB.slice(RB.indexOf('DO $postrb4263s2$'));
    for (const name of NAMES) expect(post).toContain(`'${md5(SPECS[name].head)}'`);
  });

  it('harness: guard first, built from this migration text, the rollback verbatim, no DDL on existing tables', () => {
    const lines = HARNESS.split('\n');
    expect(lines[1]).toContain('must never be run on production');
    expect(HARNESS.replace(/^--[^\n]*\n/gm, '').startsWith('DO $guard4263s2$')).toBe(true);
    expect(HARNESS).toContain(`(file md5 ${md5(S2)})`);
    expect(HARNESS).toContain(RB);
    const outside = HARNESS.replace(RB, '');
    expect(outside).not.toMatch(/^\s*(ALTER TABLE|DROP TABLE|TRUNCATE|LOCK TABLE)\b/im);
    expect(outside).toContain("RAISE EXCEPTION 'S2_RESULT %'");
    expect(HARNESS).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{11}[1-9a-f]/i);
  });

  it('harness: every mutant is proven applied (md5 of its body) before the controls run under it, and differs from S2', () => {
    const blocks = [...HARNESS.matchAll(/  -- (M_\w+) \(primary control (\w+)\)\n  BEGIN\n    o := '\{\}';\n    EXECUTE (\$mu\d+\$)\n([\s\S]*?)\n\3;\n    applied := \(SELECT md5\(prosrc\)[^\n]*IS NOT DISTINCT FROM '([0-9a-f]{32})';\n    IF applied IS NOT TRUE THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;\n/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(20);
    expect(blocks.length).toBe(count(HARNESS, "RAISE EXCEPTION 'MUTATION NOT APPLIED'"));
    for (const b of blocks) {
      const st = b[4];
      const name = /^CREATE OR REPLACE FUNCTION public\.(\w+)\(/.exec(st)![1];
      expect(`${b[1]} ${md5(body(`${st}\n`, name))}`).toBe(`${b[1]} ${b[5]}`);
      expect(`${b[1]} ${body(`${st}\n`, name) === body(S2, name)}`).toBe(`${b[1]} false`);
      expect(HARNESS).toContain(`    res := pg_temp.${b[2]}();`);
    }
  });

  it('harness refuses its rollback step unless it runs as one transaction: first statement of the rollback block, outside its handler', () => {
    const blk = HARNESS.indexOf('DO $rb4263s2$\nBEGIN\n');
    const chk = HARNESS.indexOf("  IF to_regclass('pg_temp.s2_out') IS NULL THEN\n    RAISE EXCEPTION");
    expect(blk).toBeGreaterThan(0);
    expect(chk).toBe(blk + 'DO $rb4263s2$\nBEGIN\n'.length);
    expect(HARNESS.indexOf('  BEGIN\n    EXECUTE $rbq$', chk)).toBeGreaterThan(chk);
  });
});
