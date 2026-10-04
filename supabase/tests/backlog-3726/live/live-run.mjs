#!/usr/bin/env node
// BACKLOG-3726 live checks on a LOCAL stack (`supabase start` + `supabase functions serve`).
// Usage: node live-run.mjs <phase>   (phases below; driven by live/run-live.sh)
// Env: API_URL, SERVICE_ROLE_KEY (local stack), PG_CONTAINER.
// Refuses any API_URL that is not 127.0.0.1 / localhost: nothing here can reach production.
import { execFileSync, spawn } from "node:child_process";

const API = process.env.API_URL ?? "";
const KEY = process.env.SERVICE_ROLE_KEY ?? "";
const PG = process.env.PG_CONTAINER ?? "supabase_db_keepr-test";
const host = new URL(API).hostname;
if (!["127.0.0.1", "localhost"].includes(host)) { console.error("refusing non-local API_URL"); process.exit(2); }

const ORG = "0e372600-0000-4000-8000-0000000000b1"; // pii-allow-uuid: invented fixture id
const AGENT = "aaaaaaaa-3726-4000-8000-0000000000b1"; // pii-allow-uuid: invented fixture id
const BUCKET = "submission-attachments";
let pass = 0, fail = 0;
const mask = (s) => String(s).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>");
function check(cond, label, detail = "") {
  if (cond) { pass++; console.log(`PASS ${label}`); } else { fail++; console.log(`FAIL ${label} ${mask(detail)}`); }
}
function sql(q) {
  return execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-tA", "-q"], { input: q }).toString().trim();
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
async function upload(name, body = "x") {
  const r = await fetch(`${API}/storage/v1/object/${BUCKET}/${name}`, { method: "POST", headers: { ...H, "Content-Type": "text/plain" }, body });
  if (!r.ok) throw new Error(`upload ${r.status}`);
}
async function removeApi(prefixes) {
  const r = await fetch(`${API}/storage/v1/object/${BUCKET}`, { method: "DELETE", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function exists(name) {
  const r = await fetch(`${API}/storage/v1/object/${BUCKET}/${name}`, { headers: H });
  await r.arrayBuffer().catch(() => null);
  return r.status === 200;
}
const objRow = (name) => sql(`select count(*) from storage.objects where bucket_id='${BUCKET}' and name='${name}'`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function seedPeople() {
  sql(`insert into auth.users (id, email) values ('${AGENT}', 'live3726@example.test') on conflict do nothing;
       insert into public.organizations (id) values ('${ORG}') on conflict do nothing;
       insert into public.organization_members (organization_id, user_id, role) values ('${ORG}', '${AGENT}', 'agent') on conflict do nothing;`);
}
function newSub(ageSql, status = "uploading") {
  return sql(`insert into public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status, version, created_at, updated_at)
              values ('${ORG}', '${AGENT}', 'live-' || gen_random_uuid(), 'Live Street', '${status}', 1, now() - interval '${ageSql}', now() - interval '${ageSql}') returning id`);
}
// An attachment row + object; both backdated by ageSql (a stalled upload has no recent activity).
async function attach(sub, file, ageSql = "3 hours") {
  const p = `${ORG}/${sub}/${crypto.randomUUID()}/${file}`;
  await upload(p);
  sql(`insert into public.submission_attachments (submission_id, filename, storage_path, created_at) values ('${sub}', '${file}', '${p}', now() - interval '${ageSql}');
       update storage.objects set created_at = now() - interval '${ageSql}' where bucket_id = '${BUCKET}' and name = '${p}'`);
  return p;
}
async function invokeAndWait(timeoutMs = 60000) {
  const before = sql(`select coalesce(max(started_at)::text, '') from public.submission_sweep_runs`);
  const rid = sql(`select public.submission_sweep_invoke()`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const row = sql(`select coalesce(json_agg(r)::text, '[]') from (select id, mode, outcome, counts, extract(epoch from (ended_at - started_at)) as secs from public.submission_sweep_runs
                     where started_at::text > '${before}' and outcome <> 'running' order by started_at desc limit 1) r`);
    const arr = JSON.parse(row);
    if (arr.length) return { run: arr[0], rid };
    await sleep(500);
  }
  const running = sql(`select count(*) from public.submission_sweep_runs where started_at::text > '${before}'`);
  return { run: null, rid, running };
}
function httpResponse(rid) {
  for (let i = 0; i < 40; i++) {
    const r = sql(`select coalesce(status_code::text, 'null') || '|' || coalesce(timed_out::text, 'null') || '|' || coalesce(error_msg, '') from net._http_response where id = ${rid}`);
    if (r) return r;
    execFileSync("sleep", ["0.5"]);
  }
  return "no response row";
}

const phase = process.argv[2];
seedPeople();

if (phase === "reset") {
  // Local venue only: clear rows and objects a previous live run left under the live fixture org.
  const objs = sql(`select coalesce(json_agg(name), '[]') from storage.objects where bucket_id='${BUCKET}' and name like '${ORG}/%'`);
  const names = JSON.parse(objs);
  for (let i = 0; i < names.length; i += 100) await removeApi(names.slice(i, i + 100));
  sql(`delete from public.transaction_submissions where organization_id = '${ORG}'; delete from public.submission_sweep_runs;`);
  check(sql(`select count(*) from storage.objects where name like '${ORG}/%'`) === "0", "reset: no live fixture objects left");
}

if (phase === "storage") {
  // L1 exact-name semantics; L2 service-role remove with protect_delete present.
  const sub = crypto.randomUUID();
  const child = `${ORG}/${sub}/loc/f.txt`;
  await upload(child);
  const prefixOnly = await removeApi([`${ORG}/${sub}`]);
  check(prefixOnly.status === 200 && Array.isArray(prefixOnly.body) && prefixOnly.body.length === 0, "L1 remove(folder prefix) removes nothing", JSON.stringify(prefixOnly));
  check(await exists(child) && objRow(child) === "1", "L1 child object still there");
  const trig = sql(`select count(*) from pg_trigger where tgrelid='storage.objects'::regclass and tgname like 'protect%delete%'`);
  check(Number(trig) >= 1, "L2 venue has the protect_delete trigger", trig);
  const exact = await removeApi([child, `${ORG}/${sub}/loc/missing.txt`]);
  check(exact.status === 200 && exact.body.length === 1, "L2 remove(exact) removes 1 (a missing name is a no-op)", JSON.stringify(exact.body?.length));
  check(!(await exists(child)) && objRow(child) === "0", "L2 object row and bytes gone");
}

if (phase === "dry") {
  // L3a: dry run through pg_net -> functions serve: counts only, nothing removed or fenced.
  const s = newSub("3 hours");
  const p1 = await attach(s, "a.pdf"); const p2 = await attach(s, "b.pdf");
  const prog = newSub("3 hours"); const progPath = await attach(prog, "new.pdf", "10 minutes");  // still adding files
  const orphan = `${ORG}/${crypto.randomUUID()}/loc/old.pdf`; await upload(orphan);
  sql(`update storage.objects set created_at = now() - interval '8 days' where name = '${orphan}'`);
  const { run } = await invokeAndWait();
  check(run && run.mode === "dry_run" && run.outcome === "ok", "L3a dry run row ok", JSON.stringify(run));
  check(run && run.counts.would_fence === 1 && run.counts.objects_targeted === 2 && run.counts.orphans_targeted >= 1, "L3a counts", JSON.stringify(run?.counts));
  check(await exists(p1) && await exists(p2) && await exists(orphan), "L3a nothing removed");
  check(sql(`select abandoned_at is null from public.transaction_submissions where id='${s}'`) === "t", "L3a nothing fenced");
  console.log(`PROG ${prog} ${progPath}`);
  check(!JSON.stringify(run?.counts ?? {}).includes("/"), "L3a run row has no path");
  console.log(`STATE ${JSON.stringify({ s, p1, p2, orphan })}`);
}

if (phase === "live") {
  // L3b: live run: files removed through the Storage API, then the row; orphan removed.
  const st = JSON.parse(process.env.STATE);
  const keep = newSub("3 hours", "submitted"); const keepPath = await attach(keep, "live.pdf");
  const [prog, progPath] = (process.env.PROG ?? "").split(" ");
  const { run } = await invokeAndWait();
  check(run && run.mode === "live" && run.outcome === "ok", "L3b live run row ok", JSON.stringify(run));
  check(!(await exists(st.p1)) && !(await exists(st.p2)) && !(await exists(st.orphan)), "L3b files removed (row's two + orphan)");
  check(sql(`select count(*) from public.transaction_submissions where id='${st.s}'`) === "0", "L3b stalled row deleted");
  check(await exists(keepPath) && sql(`select status from public.transaction_submissions where id='${keep}'`) === "submitted", "L3b submitted submission and its file untouched");
  check(sql(`select status || '|' || (abandoned_at is null) from public.transaction_submissions where id='${prog}'`) === "uploading|true" && await exists(progPath),
        "L3b an upload created 3 h ago that added a file 10 min ago is not fenced and keeps its file");
}

if (phase === "delay") {
  // L3c (SR condition 6): a run longer than pg_net's default 5 s still records its finish row.
  const s = newSub("3 hours"); await attach(s, "a.pdf");
  const { run, rid } = await invokeAndWait(90000);
  check(run && run.outcome === "ok" && Number(run.secs) >= 8, "L3c run of >= 8 s finished and recorded", JSON.stringify(run));
  const resp = httpResponse(rid);
  console.log(`INFO pg_net response for the long run: ${resp}`);
  check(resp.startsWith("200|false"), "L3c pg_net got the 200 (no timeout at 150 s)", resp);
}

if (phase === "timeout") {
  // L3d: same long run with timeout 5000 ms (the pg_net default) - records what happens.
  const s = newSub("3 hours"); await attach(s, "a.pdf");
  const { run, rid, running } = await invokeAndWait(60000);
  const resp = httpResponse(rid);
  console.log(`INFO with timeout 5000: pg_net response ${resp}; run row ${JSON.stringify(run)} running=${running ?? 0}`);
  check(resp.includes("|true|") || /timeout|Timeout/.test(resp), "L3d pg_net reports a timeout at 5 s", resp);
}

if (phase === "race") {
  // L4: finalize holds the row lock 3 s; a live claim through PostgREST at 1 s skips it.
  const s = newSub("3 hours");
  const sess = spawn("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-tA", "-q"]);
  let out = ""; sess.stdout.on("data", (d) => (out += d)); sess.stderr.on("data", (d) => (out += d));
  sess.stdin.end(`begin;
select set_config('request.jwt.claims', json_build_object('sub', '${AGENT}', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.finalize_submission('${s}', '{"message_ids": [], "attachments": [], "checklists": null}'::jsonb)->>'ok';
select pg_sleep(3);
commit;`);
  await sleep(1000);
  const t0 = Date.now();
  const r = await fetch(`${API}/rest/v1/rpc/submission_sweep_claim`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ p_dry_run: false }) });
  const claim = await r.json(); const ms = Date.now() - t0;
  await new Promise((res) => sess.on("close", res));
  const listed = (claim.submissions ?? []).some((x) => x.id === s);
  check(r.status === 200 && ms < 1000, `L4 live claim returned in ${ms} ms while finalize held the lock`);
  check(claim.fenced_now === 0 && !listed, "L4 the in-flight row was not fenced or listed", JSON.stringify({ fenced: claim.fenced_now, listed }));
  check(out.includes("t") && sql(`select status || '|' || (abandoned_at is null) from public.transaction_submissions where id='${s}'`) === "submitted|true", "L4 finalize committed; row submitted, not fenced", out);
  sql(`update public.submission_sweep_runs set outcome = 'ok', ended_at = now() where id = '${claim.run_id}'`);
}

if (phase === "badsecret") {
  // L5: a request with a wrong secret gets 401 and writes no run row.
  const before = sql(`select count(*) from public.submission_sweep_runs`);
  const fnUrl = `${API}/functions/v1/submission-sweep`;
  const r1 = await fetch(fnUrl, { method: "POST", headers: { "Content-Type": "application/json", "x-webhook-secret": "0".repeat(64) }, body: "{}" });
  const r2 = await fetch(fnUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await r1.text(); await r2.text();
  check(r1.status === 401 && r2.status === 401, "L5 wrong / missing secret -> 401", `${r1.status} ${r2.status}`);
  check(sql(`select count(*) from public.submission_sweep_runs`) === before, "L5 no run row written");
}

console.log(`live ${phase}: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
