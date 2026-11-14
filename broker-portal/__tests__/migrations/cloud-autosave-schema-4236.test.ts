/**
 * BACKLOG-4236 — CI tripwire for the cloud auto-save migrations.
 *
 * WHAT THIS CAN PROVE: what the two migration files and the harness rollback say. CI has no
 * database. Behaviour is proved by supabase/tests/backlog-4236 (controls, mutate.py,
 * concurrency scripts).
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const M1_FILE = '20261112180000_backlog_4236_cloud_autosave_feature_keys.sql';
const M2_FILE = '20261112190000_backlog_4236_cloud_autosave_schema.sql';

const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
/** line comments removed, whitespace collapsed */
function statements(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const M1 = statements(read(join(MIGRATIONS_DIR, M1_FILE)));
const M2 = statements(read(join(MIGRATIONS_DIR, M2_FILE)));
const RB = statements(read(join(REPO, 'supabase/tests/backlog-4236/rollback-4236.sql')));

const TABLES = [
  'cloud_autosave_settings',
  'member_addons',
  'cloud_deals',
  'cloud_deal_parties',
  'cloud_deal_checklists',
  'cloud_deal_checklist_items',
  'cloud_deal_messages',
  'cloud_blobs',
  'cloud_deal_files',
];

interface Fn {
  name: string;
  params: string;
  header: string;
  body: string;
}
const FNS: Fn[] = [];
{
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)([^$]*?)AS \$f\$(.*?)\$f\$;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(M2)) !== null) {
    FNS.push({ name: m[1], params: m[2], header: m[3], body: m[4] });
  }
}
const fn = (name: string): Fn => {
  const found = FNS.filter((f) => f.name === name);
  expect(found).toHaveLength(1);
  return found[0];
};

const WRITE_FNS = [
  'cloud_upsert_deal',
  'cloud_upsert_parties',
  'cloud_upsert_checklists',
  'cloud_upsert_checklist_items',
  'cloud_upsert_messages',
  'cloud_upsert_files',
  'cloud_register_blob',
  'cloud_mark_deal_synced',
];
const CHILD_FNS = WRITE_FNS.filter((n) => n.startsWith('cloud_upsert_') && n !== 'cloud_upsert_deal');

/** BACKLOG-4243 K6: the 13 client writes, with the argument types before and after p_expected_user_id. */
const EXPECTED_USER_FNS: { name: string; old: string; key: 'ok' | 'success' }[] = [
  { name: 'set_my_cloud_autosave', old: 'boolean, integer', key: 'success' },
  { name: 'cloud_delete_install', old: 'uuid', key: 'success' },
  { name: 'cloud_upsert_deal', old: 'jsonb', key: 'ok' },
  { name: 'cloud_upsert_parties', old: 'uuid, uuid, jsonb', key: 'ok' },
  { name: 'cloud_upsert_checklists', old: 'uuid, uuid, jsonb', key: 'ok' },
  { name: 'cloud_upsert_checklist_items', old: 'uuid, uuid, jsonb', key: 'ok' },
  { name: 'cloud_upsert_messages', old: 'uuid, uuid, jsonb', key: 'ok' },
  { name: 'cloud_upsert_files', old: 'uuid, uuid, jsonb', key: 'ok' },
  { name: 'cloud_tombstone', old: 'uuid, text, uuid[]', key: 'ok' },
  { name: 'cloud_delete_deal', old: 'uuid', key: 'ok' },
  { name: 'cloud_mark_deal_synced', old: 'uuid, uuid', key: 'ok' },
  { name: 'cloud_register_blob', old: 'text, bigint, text', key: 'ok' },
  { name: 'cloud_confirm_blob', old: 'uuid', key: 'ok' },
];
/** the first lock or write statement in a body */
const FIRST_LOCK_OR_WRITE = /FOR (SHARE|UPDATE|NO KEY UPDATE)|\bINSERT INTO\b|\bUPDATE public\.|\bDELETE FROM\b|\bEXECUTE format\(/;

describe('BACKLOG-4236 cloud auto-save migrations', () => {
  it('both files exist, M1 sorts before M2, both after 20261112170000', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.includes('_backlog_4236_'));
    expect(files.sort()).toEqual([M1_FILE, M2_FILE]);
    expect(M1_FILE < M2_FILE).toBe(true);
    expect(M1_FILE > '20261112170000').toBe(true);
    expect(M2_FILE > '20261112170000').toBe(true);
  });

  it('M1 inserts both keys off everywhere, unbuilt, with no tier', () => {
    expect(M1).toContain(
      "('cloud_autosave', 'Cloud auto-save', 'An online copy of the user''s own deals. Read per user by get_my_cloud_autosave_state() (BACKLOG-4236).', 'sync', 'boolean', 'false', NULL, 164, false)",
    );
    expect(M1).toContain("'sync', 'boolean', 'false', NULL, 165, false)");
    expect(M1).toContain("SELECT p.id, fd.id, false, 'false' FROM public.plans p");
    expect(M1).toContain("WHERE fd.key IN ('cloud_autosave', 'cloud_autosave_assignable')");
    expect(M1.match(/ON CONFLICT/g)).toHaveLength(2);
  });

  it('every table: RLS on, all privileges revoked from client roles, SELECT only, one SELECT policy', () => {
    for (const t of TABLES) {
      expect(M2).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(M2).toContain(`REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated;`);
      expect(M2).toContain(`GRANT SELECT ON TABLE public.${t} TO authenticated;`);
      const policies = M2.match(new RegExp(`CREATE POLICY \\w+ ON public\\.${t} `, 'g')) ?? [];
      expect(policies).toHaveLength(1);
      expect(M2).toMatch(new RegExp(`CREATE POLICY ${t}_select_own ON public\\.${t} FOR SELECT TO authenticated USING \\(`));
    }
    expect(M2).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL) TO authenticated USING/);
    expect(M2).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL|TRUNCATE)[^;]* ON TABLE/);
    expect(M2).not.toMatch(/TO anon\b/);
    expect(M2).not.toMatch(/\b(serial|bigserial|GENERATED [A-Z ]*AS IDENTITY|CREATE SEQUENCE|CREATE TYPE)\b/i);
    expect(M2).not.toContain('can_review_submission');
    expect(M2).not.toContain('ALTER PUBLICATION');
  });

  it('storage: two bucket-scoped policies, INSERT and SELECT, with the owner path and qualified names', () => {
    const storagePolicies = M2.match(/CREATE POLICY "[^"]+" ON storage\.objects FOR (\w+)/g) ?? [];
    expect(storagePolicies).toEqual([
      'CREATE POLICY "Cloud deal files: owner uploads registered blob" ON storage.objects FOR INSERT',
      'CREATE POLICY "Cloud deal files: owner reads live blob" ON storage.objects FOR SELECT',
    ]);
    const ins = M2.slice(M2.indexOf('"Cloud deal files: owner uploads registered blob" ON storage.objects FOR INSERT'));
    expect(ins).toMatch(/^[^;]*bucket_id = 'cloud-deal-files' AND split_part\(objects\.name, '\/', 1\) = \(SELECT auth\.uid\(\)\)::text/);
    expect(ins).toMatch(/^[^;]*\(SELECT public\.cloud_autosave_entitled\(\)\)/);
    expect(ins).toMatch(/^[^;]*b\.storage_path = objects\.name[^;]*b\.uploaded_at IS NULL[^;]*b\.purge_requested_at IS NULL/);
    const sel = M2.slice(M2.indexOf('"Cloud deal files: owner reads live blob" ON storage.objects FOR SELECT'));
    expect(sel).toMatch(/^[^;]*bucket_id = 'cloud-deal-files'[^;]*b\.purge_requested_at IS NULL/);
    expect(M2).toContain("VALUES ('cloud-deal-files', 'cloud-deal-files', false, 52428800, NULL)");
  });

  it('every function: EXECUTE revoked from all four roles with its full signature, then one GRANT at most', () => {
    expect(FNS.length).toBe(22);
    for (const f of FNS) {
      const types = f.params
        .split(',')
        .map((p) => p.trim().replace(/\s+DEFAULT\s+.*$/i, '').split(/\s+/).slice(1).join(' '))
        .filter((x) => x.length > 0)
        .join(', ');
      const sig = `public.${f.name}(${types})`;
      expect(M2).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role;`);
      const grants = M2.match(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig.replace(/[()[\]]/g, '\\$&')} TO`, 'g')) ?? [];
      expect(grants.length).toBeLessThanOrEqual(1);
      expect(f.header).toContain("SET search_path = ''");
    }
    expect(M2).toContain(
      'GRANT EXECUTE ON FUNCTION public.assign_member_addon(uuid, uuid, text, boolean, timestamptz) TO service_role;',
    );
    for (const internal of ['_cloud_autosave_license(uuid)', '_cloud_autosave_current_notice_version()', '_cloud_fence_unreferenced(uuid, uuid[])']) {
      expect(M2).not.toContain(`GRANT EXECUTE ON FUNCTION public.${internal}`);
    }
  });

  it('every write checks the entitlement after the settings lock; delete paths do not', () => {
    for (const name of WRITE_FNS) {
      const b = fn(name).body;
      const lock = b.indexOf('FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;');
      const gate = b.indexOf('IF public.cloud_autosave_entitled() IS NOT TRUE THEN');
      expect(lock).toBeGreaterThan(0);
      expect(gate).toBeGreaterThan(lock);
    }
    for (const name of ['cloud_tombstone', 'cloud_delete_deal', 'cloud_delete_install', 'set_my_cloud_autosave']) {
      expect(fn(name).body).not.toContain('cloud_autosave_entitled()');
    }
    expect(M2).not.toMatch(/IF NOT public\./);
  });

  it('install scope: deal key, and every child upsert, tombstone and mark-synced takes and checks the install id', () => {
    expect(M2).toContain('CONSTRAINT cloud_deals_local_uq UNIQUE (owner_user_id, source_install_id, local_transaction_id)');
    expect(M2).toContain('source_install_id uuid NOT NULL,');
    for (const name of [...CHILD_FNS, 'cloud_tombstone', 'cloud_mark_deal_synced']) {
      const f = fn(name);
      expect(f.params.startsWith('p_expected_user_id uuid, p_source_install_id uuid,')).toBe(true);
      expect(f.body).toMatch(/source_install_id = (p_source_install_id|\$3)/);
      expect(f.body).toMatch(/owner_user_id = (v_uid|\$2)/);
    }
    expect(fn('cloud_delete_deal').body).not.toContain('source_install_id');
  });

  it('BACKLOG-4243 K6: each of the 13 writes takes p_expected_user_id first and refuses a different user before any lock or write', () => {
    expect(EXPECTED_USER_FNS).toHaveLength(13);
    for (const w of EXPECTED_USER_FNS) {
      const f = fn(w.name);
      expect(f.params.startsWith('p_expected_user_id uuid, ')).toBe(true);
      const nullCheck = f.body.search(/IF v_uid IS NULL THEN RETURN jsonb_build_object\(/);
      const check = f.body.indexOf(
        `IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('${w.key}', false, 'error', 'wrong_account'); END IF;`,
      );
      expect(nullCheck).toBeGreaterThan(0);
      expect(check).toBeGreaterThan(nullCheck);
      expect(f.body.match(/p_expected_user_id/g)).toHaveLength(1);
      const firstWrite = f.body.search(FIRST_LOCK_OR_WRITE);
      expect(firstWrite).toBeGreaterThan(check);
      // the earlier signature is dropped right before the new one is created; grants name the new one
      const drop = `DROP FUNCTION IF EXISTS public.${w.name}(${w.old}); CREATE OR REPLACE FUNCTION public.${w.name}(p_expected_user_id uuid, `;
      expect(M2.split(drop)).toHaveLength(2);
      expect(M2).toContain(`REVOKE ALL ON FUNCTION public.${w.name}(uuid, ${w.old}) FROM PUBLIC, anon, authenticated, service_role;`);
      expect(M2).toContain(`GRANT EXECUTE ON FUNCTION public.${w.name}(uuid, ${w.old}) TO authenticated;`);
      expect(M2).not.toContain(`ON FUNCTION public.${w.name}(${w.old})`);
    }
    // every client write is in the list (positive: the list is not a subset of what the file defines)
    const writes = FNS.filter((f) => /^(cloud_upsert_|cloud_tombstone|cloud_delete_|cloud_mark_|cloud_register_|cloud_confirm_|set_my_)/.test(f.name));
    expect(writes.map((f) => f.name).sort()).toEqual(EXPECTED_USER_FNS.map((w) => w.name).sort());
    // reads keep their signatures
    for (const name of ['get_my_cloud_autosave_state', 'cloud_list_installs', 'cloud_autosave_entitled']) {
      expect(fn(name).params).toBe('');
    }
  });

  it('BACKLOG-4243 K1, K2, K4: a file attaches only an uploaded blob and a live message; a size mismatch fences the blob', () => {
    const files = fn('cloud_upsert_files').body;
    expect(files).toMatch(/AND b\.sha256 = r ->> 'blob_sha256' AND b\.uploaded_at IS NOT NULL \/\*FILE:uploaded\*\/ AND b\.purge_requested_at IS NULL;/);
    expect(files).toMatch(/AND m\.local_message_id = r ->> 'message_local_id' AND m\.removed_at IS NULL; \/\*FILE:livemessage\*\//);
    const confirm = fn('cloud_confirm_blob').body;
    expect(confirm).toContain(
      "IF v_size IS DISTINCT FROM b.size_bytes::text THEN /*CONFIRM:size*/ UPDATE public.cloud_blobs SET purge_requested_at = now() WHERE id = b.id; /*CONFIRM:fence*/ RETURN jsonb_build_object('ok', false, 'error', 'size_mismatch'); END IF;",
    );
  });

  it('the state, entitlement, licence and install-list functions are STABLE and neither lock nor write', () => {
    for (const name of ['get_my_cloud_autosave_state', 'cloud_autosave_entitled', '_cloud_autosave_license', 'cloud_list_installs']) {
      const f = fn(name);
      expect(f.header).toMatch(/\bSTABLE\b/);
      expect(f.body).not.toMatch(/FOR (SHARE|UPDATE|NO KEY UPDATE)|\bINSERT INTO\b|\bUPDATE public\.|\bDELETE FROM\b/);
    }
    for (const name of ['get_my_cloud_autosave_state', 'cloud_autosave_entitled']) {
      const b = fn(name).body;
      expect(b).toContain('_cloud_autosave_license(');
      expect(b).not.toMatch(/plan_features|organization_plans|member_addons/);
    }
  });

  it('turn-off is one unit that calls the disconnect only when present', () => {
    const b = fn('set_my_cloud_autosave').body;
    expect(b).toContain("IF to_regprocedure('public._mcp_disconnect_all_for(uuid,text)') IS NOT NULL THEN");
    expect(b).toContain("v_ai := public._mcp_disconnect_all_for(v_uid, 'cloud_off');");
    expect(b).toContain("EXCEPTION WHEN OTHERS THEN /*SET:unit*/ RETURN jsonb_build_object('success', false, 'error', 'turn_off_failed');");
  });

  it('limits: 500 rows and 16 MB per child batch, 1 MB per deal, 1,000,000-character body, 50 MB per blob', () => {
    for (const name of CHILD_FNS) {
      const b = fn(name).body;
      expect(b).toContain('IF jsonb_array_length(p_rows) > 500 THEN');
      expect(b).toContain('IF octet_length(p_rows::text) > 16777216 THEN');
    }
    expect(fn('cloud_upsert_deal').body).toContain('IF octet_length(p_deal::text) > 1048576 THEN');
    expect(fn('cloud_upsert_messages').body).toContain('IF char_length(v_body) > 1000000 THEN');
    expect(fn('cloud_register_blob').body).toContain('IF p_size_bytes > 52428800 THEN');
  });

  it('the rollback removes every function, table, policy, bucket, key row and ledger row', () => {
    for (const f of FNS) expect(RB).toContain(`DROP FUNCTION IF EXISTS public.${f.name}(`);
    for (const w of EXPECTED_USER_FNS) {
      expect(RB).toContain(`DROP FUNCTION IF EXISTS public.${w.name}(uuid, ${w.old});`);
      expect(RB).toContain(`DROP FUNCTION IF EXISTS public.${w.name}(${w.old});`);
    }
    for (const t of TABLES) expect(RB).toContain(`DROP TABLE IF EXISTS public.${t};`);
    expect(RB).toContain("DELETE FROM storage.buckets WHERE id = 'cloud-deal-files';");
    expect(RB).toContain("DELETE FROM public.feature_definitions WHERE key IN ('cloud_autosave', 'cloud_autosave_assignable');");
    expect(RB).toContain("DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('20261112180000', '20261112190000');");
  });

  it('no client code reads either key yet (positive control: autodetect_eval is found)', () => {
    const scan = (dir: string, out: string[]): void => {
      for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.next' || e.name === '__tests__') continue;
          scan(p, out);
        } else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) {
          const text = readFileSync(join(REPO, p), 'utf8');
          if (text.includes("'cloud_autosave") || text.includes('"cloud_autosave')) out.push(p);
        }
      }
    };
    const hits: string[] = [];
    for (const d of ['electron', 'src', 'broker-portal']) scan(d, hits);
    expect(hits).toEqual([]);
    expect(readFileSync(join(REPO, 'electron/handlers/featureGateHandlers.ts'), 'utf8')).toContain('autodetect_eval');
  });
});
