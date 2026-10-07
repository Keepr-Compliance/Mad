// BACKLOG-3403 live run: supabase-js against a LOCAL Supabase stack (real
// GoTrue, PostgREST and storage-api), never production.
//
//   node live-run.mjs pre    # before the migration: records the PGRST202 answer
//   node live-run.mjs post   # after the migration is applied (committed)
//
// Env: API_URL, ANON_KEY, SERVICE_ROLE_KEY (from `supabase status -o env`),
// PG_CONTAINER (default supabase_db_keepr-test). The venue must have
// lib/parity-prelude.sql loaded. Users are invented (example.test).
import { createClient } from '@supabase/supabase-js';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_URL = process.env.API_URL;
const ANON = process.env.ANON_KEY;
const SERVICE = process.env.SERVICE_ROLE_KEY;
const PG = process.env.PG_CONTAINER || 'supabase_db_keepr-test';
if (!API_URL || !ANON || !SERVICE) throw new Error('API_URL, ANON_KEY and SERVICE_ROLE_KEY are required');
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(API_URL)) throw new Error('refusing: API_URL is not a local stack');

const ORG = '0e340300-0000-4000-8000-000000000001'; // pii-allow-uuid: invented fixture id
const ORG2 = '0e340300-0000-4000-8000-000000000002'; // pii-allow-uuid: invented fixture id
const BUCKET = 'submission-attachments';
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(API_URL, SERVICE, opts);
const lines = [];
let fails = 0;
const log = (s) => { lines.push(s); console.log(s); };
function check(label, cond, detail) {
  log(`${cond ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
  if (!cond) fails += 1;
}
const psql = (sql) =>
  execFileSync('docker', ['exec', '-i', PG, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-tA', '-q'], { input: sql })
    .toString()
    .trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function user(tag) {
  const email = `live3403-${tag}@example.test`;
  const password = 'Live-3403-local-only';
  let id;
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created?.user) id = created.user.id;
  else {
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    id = list.users.find((u) => u.email === email)?.id;
    if (!id) throw new Error(`createUser ${tag}: ${error?.message}`);
  }
  const client = createClient(API_URL, ANON, opts);
  const { data: s, error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw new Error(`sign in ${tag}: ${e2.message}`);
  return { id, client, token: s.session.access_token };
}

async function people() {
  const A = await user('agent-a');
  const B = await user('agent-b');
  const K = await user('broker-k');
  const O = await user('agent-other-org');
  const Z = await user('staff-z');
  psql(`
    insert into public.organizations(id) values ('${ORG}'), ('${ORG2}') on conflict do nothing;
    delete from public.organization_members where organization_id in ('${ORG}', '${ORG2}');
    insert into public.organization_members(organization_id, user_id, role) values
      ('${ORG}', '${A.id}', 'agent'), ('${ORG}', '${B.id}', 'agent'), ('${ORG}', '${K.id}', 'broker'),
      ('${ORG2}', '${O.id}', 'agent');
    delete from public.internal_roles where user_id = '${Z.id}';
    insert into public.internal_roles(user_id) values ('${Z.id}');`);
  return { A, B, K, O, Z };
}

async function pre() {
  const { A } = await people();
  const exists = psql(`select to_regprocedure('public.finalize_submission(uuid,jsonb)') is not null`);
  check('pre: finalize_submission is absent on the venue', exists === 'f', exists);
  const res = await fetch(`${API_URL}/rest/v1/rpc/finalize_submission`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${A.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_submission_id: randomUUID(), p_manifest: { message_ids: [], attachments: [], checklists: null } }),
  });
  const body = await res.json();
  const viaJs = await A.client.rpc('finalize_submission', { p_submission_id: randomUUID(), p_manifest: {} });
  const fixture = {
    _source: 'BACKLOG-3403 live run, local stack (PostgREST ' + (res.headers.get('server') || 'unknown') + '), function absent, signed-in user',
    http_status: res.status,
    body,
    supabase_js: { status: viaJs.status, statusText: viaJs.statusText, error: viaJs.error, data: viaJs.data },
  };
  fs.writeFileSync(path.join(HERE, 'pgrst202.json'), JSON.stringify(fixture, null, 2) + '\n');
  check('pre: PostgREST answers PGRST202 for the missing RPC', body.code === 'PGRST202', { status: res.status, code: body.code });
  check('pre: supabase-js surfaces the same code', viaJs.error?.code === 'PGRST202', viaJs.error?.code);
}

function seedSubmission(A, { status = 'uploading', withObject = true } = {}) {
  const S = randomUUID();
  const M1 = randomUUID();
  const M2 = randomUUID();
  const AT1 = randomUUID();
  const P1 = `${ORG}/${S}/loc1/contract.pdf`;
  psql(`
    insert into public.transaction_submissions(id, organization_id, submitted_by, local_transaction_id, property_address, status, version)
      values ('${S}', '${ORG}', '${A.id}', 'live-${S}', 'Fixture Street', '${status}', 1);
    insert into public.submission_messages(id, submission_id, channel) values ('${M1}', '${S}', 'sms'), ('${M2}', '${S}', 'email');
    insert into public.submission_attachments(id, submission_id, message_id, filename, storage_path)
      values ('${AT1}', '${S}', '${M1}', 'contract.pdf', '${P1}');`);
  return { S, M1, M2, AT1, P1, manifest: { message_ids: [M1, M2], attachments: [{ id: AT1, storage_path: P1, message_id: M1 }], checklists: null }, withObject };
}
async function upload(A, p) {
  const { error } = await A.client.storage.from(BUCKET).upload(p, Buffer.from('%PDF-1.4 live 3403\n'), { contentType: 'application/pdf', upsert: false });
  if (error) throw new Error(`upload: ${error.message}`);
}
const objectCount = (p) => Number(psql(`select count(*) from storage.objects where bucket_id = '${BUCKET}' and name = '${p}'`));
const statusOf = (S) => psql(`select status from public.transaction_submissions where id = '${S}'`);
async function bytesGone(p) {
  const { data, error } = await admin.storage.from(BUCKET).download(p);
  return !data && !!error;
}
async function fence(client, S, extra = {}) {
  const t0 = Date.now();
  const { data, error } = await client
    .from('transaction_submissions')
    .update({ submission_metadata: { ...extra, abandoned: true } })
    .eq('id', S)
    .eq('status', 'uploading')
    .select('id');
  return { rows: data?.length ?? 0, error, ms: Date.now() - t0 };
}
// A second session: psql as the agent, finalize inside an open transaction held for holdMs.
function holdFinalize(A, S, manifest, holdMs) {
  const sql = `begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '${JSON.stringify({ sub: A.id, role: 'authenticated' })}', true);
    select 'FIN:' || public.finalize_submission('${S}', '${JSON.stringify(manifest)}'::jsonb)::text;
    select pg_sleep(${holdMs / 1000});
    commit;`;
  return new Promise((resolve) => {
    const p = spawn('docker', ['exec', '-i', PG, 'psql', '-U', 'postgres', '-X', '-tA', '-q']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim()));
    p.stdin.end(sql);
  });
}

async function post() {
  const { A, B, K, O, Z } = await people();
  const anon = createClient(API_URL, ANON, opts);

  // L1 retried inserts through PostgREST with ignoreDuplicates.
  {
    const S = randomUUID();
    const M = randomUUID();
    const AT = randomUUID();
    const p = `${ORG}/${S}/loc1/a.pdf`;
    const parent = { id: S, organization_id: ORG, submitted_by: A.id, local_transaction_id: `live-dup-${S}`, property_address: 'Fixture Street', status: 'uploading', version: 1 };
    const r1 = await A.client.from('transaction_submissions').upsert(parent, { onConflict: 'id', ignoreDuplicates: true });
    const r2 = await A.client.from('transaction_submissions').upsert(parent, { onConflict: 'id', ignoreDuplicates: true });
    const m = { id: M, submission_id: S, channel: 'sms' };
    const m1 = await A.client.from('submission_messages').upsert([m], { onConflict: 'id', ignoreDuplicates: true });
    const m2 = await A.client.from('submission_messages').upsert([m], { onConflict: 'id', ignoreDuplicates: true });
    const a = { id: AT, submission_id: S, message_id: M, filename: 'a.pdf', storage_path: p };
    const a1 = await A.client.from('submission_attachments').upsert([a], { onConflict: 'id', ignoreDuplicates: true });
    const a2 = await A.client.from('submission_attachments').upsert([a], { onConflict: 'id', ignoreDuplicates: true });
    const counts = psql(`select (select count(*) from public.transaction_submissions where id='${S}') || ',' ||
                               (select count(*) from public.submission_messages where id='${M}') || ',' ||
                               (select count(*) from public.submission_attachments where id='${AT}')`);
    check('L1 retried upserts (parent, message, attachment row): no error', [r1, r2, m1, m2, a1, a2].every((r) => !r.error),
      [r1, r2, m1, m2, a1, a2].map((r) => r.error?.code ?? null));
    check('L1 retried upserts: exactly one row each', counts === '1,1,1', counts);
    const bad = await A.client.from('submission_attachments').upsert([{ ...a, id: randomUUID(), storage_path: `${ORG}/${randomUUID()}/x/a.pdf` }], { onConflict: 'id', ignoreDuplicates: true });
    check('L1b attachment row outside its own folder: refused by RLS', bad.error?.code === '42501', bad.error?.code);
  }

  // L2 finalize through PostgREST.
  const f = seedSubmission(A);
  await upload(A, f.P1);
  {
    const viaAnon = await anon.rpc('finalize_submission', { p_submission_id: f.S, p_manifest: f.manifest });
    check('L2 anon key: finalize refused', !!viaAnon.error && viaAnon.data === null, { status: viaAnon.status, code: viaAnon.error?.code, message: viaAnon.error?.message });
    check('L2 anon key: submission still uploading', statusOf(f.S) === 'uploading', statusOf(f.S));
    const byPeer = await B.client.rpc('finalize_submission', { p_submission_id: f.S, p_manifest: f.manifest });
    check('L2 same-org agent: not_owner', byPeer.data?.code === 'not_owner', byPeer.data);
    const ok = await A.client.rpc('finalize_submission', { p_submission_id: f.S, p_manifest: f.manifest });
    check('L2 submitter: finalize ok -> submitted', ok.data?.ok === true && ok.data?.status === 'submitted' && statusOf(f.S) === 'submitted', ok.data);
    const again = await A.client.rpc('finalize_submission', { p_submission_id: f.S, p_manifest: f.manifest });
    check('L2 repeat: already_final', again.data?.already_final === true, again.data);
  }

  // L3 storage remove().
  {
    const u = seedSubmission(A);
    await upload(A, u.P1);
    const k = await K.client.storage.from(BUCKET).remove([u.P1]);
    check('L3a broker of the org: remove() removes nothing', (k.data?.length ?? 0) === 0 && objectCount(u.P1) === 1, { removed: k.data?.length, error: k.error?.message });
    const noFence = await A.client.storage.from(BUCKET).remove([u.P1]);
    check('L3b submitter, uploading, NOT fenced: remove() removes nothing', (noFence.data?.length ?? 0) === 0 && objectCount(u.P1) === 1, { removed: noFence.data?.length });
    const fz = await fence(A.client, u.S);
    check('L3c fence on an uploading submission: 1 row', fz.rows === 1 && !fz.error, fz);
    const kAfter = await K.client.storage.from(BUCKET).remove([u.P1]);
    check('L3d broker after the fence: remove() removes nothing', (kAfter.data?.length ?? 0) === 0 && objectCount(u.P1) === 1, { removed: kAfter.data?.length });
    const own = await A.client.storage.from(BUCKET).remove([u.P1]);
    check('L3e submitter, fenced: remove() removes the object', own.data?.length === 1 && objectCount(u.P1) === 0, { removed: own.data?.length, error: own.error?.message });
    check('L3e bytes gone (service download fails)', await bytesGone(u.P1));
    const after = await A.client.storage.from(BUCKET).remove([f.P1]);
    const fenceSubmitted = await fence(A.client, f.S);
    check('L3f after finalize: fence matches 0 rows', fenceSubmitted.rows === 0, fenceSubmitted);
    const after2 = await A.client.storage.from(BUCKET).remove([f.P1]);
    check('L3f after finalize: remove() removes nothing, bytes still there',
      (after.data?.length ?? 0) === 0 && (after2.data?.length ?? 0) === 0 && objectCount(f.P1) === 1 && !(await bytesGone(f.P1)),
      { removed: [after.data?.length, after2.data?.length] });
  }

  // L4 the race, two sessions: psql holds finalize uncommitted; PostgREST/storage-api act meanwhile.
  {
    const r = seedSubmission(A);
    await upload(A, r.P1);
    const held = holdFinalize(A, r.S, r.manifest, 4000);
    await sleep(1000);
    const rm = await A.client.storage.from(BUCKET).remove([r.P1]);
    const fz = await fence(A.client, r.S);
    const fin = await held;
    check('R1 remove() while finalize holds the row (no fence): removes nothing', (rm.data?.length ?? 0) === 0, { removed: rm.data?.length });
    check('R2 fence waits for finalize, then matches 0 rows', fz.rows === 0 && fz.ms >= 2000, fz);
    check('R1/R2 finalize committed; object still there', /"ok": true/.test(fin) && statusOf(r.S) === 'submitted' && objectCount(r.P1) === 1, { fin, status: statusOf(r.S), objects: objectCount(r.P1) });
    const rmAfter = await A.client.storage.from(BUCKET).remove([r.P1]);
    check('R2 remove() after the 0-row fence: removes nothing', (rmAfter.data?.length ?? 0) === 0 && objectCount(r.P1) === 1, { removed: rmAfter.data?.length });

    const r3 = seedSubmission(A);
    await upload(A, r3.P1);
    const fz3 = await fence(A.client, r3.S, { excluded_files: [{ filename: 'kept.pdf', reason: 'file_too_large' }] });
    const fin3 = await A.client.rpc('finalize_submission', { p_submission_id: r3.S, p_manifest: r3.manifest });
    check('R3 fence first (1 row), then finalize: abandoned, still uploading', fz3.rows === 1 && fin3.data?.code === 'abandoned' && statusOf(r3.S) === 'uploading', { fence: fz3.rows, fin: fin3.data });
    const rm3 = await A.client.storage.from(BUCKET).remove([r3.P1]);
    check('R3 abandoned upload: remove() removes the object', rm3.data?.length === 1 && objectCount(r3.P1) === 0, { removed: rm3.data?.length });
  }

  // L4b attachment-ROW delete during an open finalize (no fence), and the row lock on a refusal.
  {
    const r = seedSubmission(A);
    await upload(A, r.P1);
    const held = holdFinalize(A, r.S, r.manifest, 4000);
    await sleep(1000);
    const del = await A.client.from('submission_attachments').delete().eq('submission_id', r.S).select('id');
    const fin = await held;
    const rows = Number(psql(`select count(*) from public.submission_attachments where submission_id = '${r.S}'`));
    check('R1-row attachment-row delete during finalize (no fence): deletes nothing', !del.error && (del.data?.length ?? 0) === 0, { deleted: del.data?.length, error: del.error?.code });
    check('R1-row finalize committed with its attachment row', /"ok": true/.test(fin) && statusOf(r.S) === 'submitted' && rows === 1, { status: statusOf(r.S), rows });

    const l = seedSubmission(A);
    await upload(A, l.P1);
    const short = { ...l.manifest, message_ids: [l.M1] };
    const heldRefusal = holdFinalize(A, l.S, short, 4000);
    await sleep(1000);
    const fz = await fence(A.client, l.S);
    const finR = await heldRefusal;
    check('L6 finalize that refuses still holds the row: the fence waits, then matches 1 row', /incomplete/.test(finR) && fz.rows === 1 && fz.ms >= 2000, { fence: fz, fin: finR.split('\n').pop() });
  }

  // L5 the per-attempt table through the API.
  {
    const S = randomUUID();
    const rec = await A.client.rpc('record_submission_attempt', {
      p_submission_id: S, p_organization_id: ORG, p_outcome: 'failed', p_stage: 'upload', p_reason_code: 'retries_exhausted',
      p_retry_count: 3, p_counts: { messages: 4, attachments: 2, note: 'dropped' }, p_app_version: '2.39.0', p_platform: 'darwin',
    });
    check('L5 record_submission_attempt as the agent: ok', rec.data?.ok === true, rec.data ?? rec.error);
    const fake = await A.client.rpc('record_submission_attempt', { p_submission_id: randomUUID(), p_organization_id: ORG, p_outcome: 'committed' });
    check('SR1 record_submission_attempt refuses outcome committed', fake.data?.ok === false && fake.data?.code === 'committed_is_server_only', fake.data ?? fake.error);
    const anonRec = await anon.rpc('record_submission_attempt', { p_submission_id: randomUUID(), p_organization_id: ORG, p_outcome: 'failed' });
    check('L5 record_submission_attempt with the anon key: refused', !!anonRec.error, anonRec.error?.code);
    const seen = async (c) => ((await c.from('submission_attempts').select('submission_id, outcome, counts').eq('submission_id', S)).data ?? []);
    const [a, k, o, z, b] = [await seen(A.client), await seen(K.client), await seen(O.client), await seen(Z.client), await seen(B.client)];
    check('L5 agent sees own attempt; counts kept only numbers', a.length === 1 && a[0].counts.note === undefined && a[0].counts.messages === 4, a);
    check('L5 broker of the org sees it', k.length === 1, k.length);
    check('L5 staff (internal role) sees it', z.length === 1, z.length);
    check('L5 agent of another org does not', o.length === 0, o.length);
    check('L5 another agent of the same org does not', b.length === 0, b.length);
    const direct = await A.client.from('submission_attempts').insert({ submission_id: randomUUID(), user_id: A.id, organization_id: ORG });
    check('L5 direct INSERT into submission_attempts: refused', direct.error?.code === '42501', direct.error?.code);
    const committed = await A.client.from('submission_attempts').select('outcome, stage').eq('submission_id', f.S);
    check('L5 finalize wrote the attempt row as committed', committed.data?.[0]?.outcome === 'committed', committed.data);
  }
}

const phase = process.argv[2];
if (phase === 'pre') await pre();
else if (phase === 'post') await post();
else throw new Error('usage: node live-run.mjs pre|post');
log(`live-run ${phase}: ${lines.filter((l) => l.startsWith('PASS')).length} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
