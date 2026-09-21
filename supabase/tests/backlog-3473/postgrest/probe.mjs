#!/usr/bin/env node
// BACKLOG-3473: controls C22 and the HTTP half of C1-anon, through the real
// PostgREST and the real @supabase/supabase-js client.
//
//   SUPABASE_URL=http://<tailnet or loopback>:54321 \
//   SUPABASE_JWT_SECRET=<the venue's JWT secret> \
//   node supabase/tests/backlog-3473/postgrest/probe.mjs [--expect-red]
//
// Needs run.sh apply and run.sh probe-seed first, run.sh probe-cleanup after.
//
//   D1  the desktop read (BACKLOG-3475) as P1's agent: 200, exactly the one
//       active P1 template, with its 2 items embedded, ordered by sort_order
//   D2  the same request for P1's organization as P2's agent: 200, 0 rows
//   A*  anon (no user JWT) on each of the 7 tables: 401, code 42501
// Exit 0 when every case holds. With --expect-red (run.sh probe-mutant): exit
// 0 only when D1 FAILS -- the mutant revoked SELECT from authenticated.
//
// Writes fixtures/postgrest-desktop-read.json: the D1 and D2 responses
// verbatim, every UUID replaced (fixture ids by label, generated ids by
// <generated-uuid-N>). The JWT secret is never written anywhere; tokens live
// five minutes.

import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const require = createRequire(join(REPO, "package.json"));
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_JS_VERSION = require("@supabase/supabase-js/package.json").version;

const expectRed = process.argv.includes("--expect-red");
const url = process.env.SUPABASE_URL ?? "";
const secret = process.env.SUPABASE_JWT_SECRET ?? "";
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
const TAILNET = /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.\d{1,3}\.\d{1,3}$/;
if (!(host === "127.0.0.1" || host === "localhost" || TAILNET.test(host))) {
  console.error(`REFUSING: SUPABASE_URL host '${host}' is neither loopback nor a Tailscale address.`);
  process.exit(2);
}
if (secret.length < 32) {
  console.error("REFUSING: SUPABASE_JWT_SECRET is not set.");
  process.exit(2);
}

const P1_AGENT = "00000000-0000-4000-8000-00003473e501"; // pii-allow-uuid: invented fixture id
const P2_AGENT = "00000000-0000-4000-8000-00003473e502"; // pii-allow-uuid: invented fixture id
const P1 = "00000000-0000-4000-8000-00003473e5a1"; // pii-allow-uuid: invented fixture id
const FIXTURE = {
  [P1_AGENT]: "<fixture:user-p1-agent>",
  [P2_AGENT]: "<fixture:user-p2-agent>",
  [P1]: "<fixture:org-p1>",
  "00000000-0000-4000-8000-00003473e5a2": "<fixture:org-p2>", // pii-allow-uuid: invented fixture id
  "00000000-0000-4000-8000-00003473e5b1": "<fixture:template-p1-active>", // pii-allow-uuid: invented fixture id
  "00000000-0000-4000-8000-00003473e5b2": "<fixture:template-p1-archived>", // pii-allow-uuid: invented fixture id
  "00000000-0000-4000-8000-00003473e5b3": "<fixture:template-p2>", // pii-allow-uuid: invented fixture id
  "00000000-0000-4000-8000-00003473e5c1": "<fixture:item-p1-1>", // pii-allow-uuid: invented fixture id
  "00000000-0000-4000-8000-00003473e5c2": "<fixture:item-p1-2>", // pii-allow-uuid: invented fixture id
};

const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
function jwt(claims) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: "supabase-demo", iat: now, exp: now + 300, ...claims });
  const sig = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const anonKey = jwt({ role: "anon" });
const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const clientFor = (userId) =>
  createClient(url, anonKey, {
    ...opts,
    global: { headers: { Authorization: `Bearer ${jwt({ role: "authenticated", aud: "authenticated", sub: userId })}` } },
  });
const anon = createClient(url, anonKey, opts);

// The desktop read, as BACKLOG-3475 will issue it (plan v1 section 5).
const desktopRead = (c) =>
  c
    .from("checklist_templates")
    .select(
      "id,name,description,sort_order,updated_at,checklist_template_items(id,title,description,is_required,expected_document_type,sort_order)",
    )
    .eq("organization_id", P1)
    .is("archived_at", null)
    .order("sort_order");

const results = [];
function record(label, ok, detail, response) {
  results.push({ label, ok, detail, response });
  console.log(`${ok ? "GREEN" : "RED  "} ${label.padEnd(44)} ${detail}`);
}

const d1 = await desktopRead(clientFor(P1_AGENT));
const d1Items = Array.isArray(d1.data) && d1.data.length === 1 ? d1.data[0].checklist_template_items ?? [] : [];
record(
  "D1 desktop read as P1's agent",
  d1.status === 200 && !d1.error && Array.isArray(d1.data) && d1.data.length === 1 &&
    d1.data[0].name === "Probe template" && d1Items.length === 2,
  `status=${d1.status} error=${d1.error ? d1.error.code : "null"} rows=${Array.isArray(d1.data) ? d1.data.length : typeof d1.data} items=${d1Items.length}`,
  { status: d1.status, error: d1.error, data: d1.data },
);

const d2 = await desktopRead(clientFor(P2_AGENT));
record(
  "D2 same request, P2's agent",
  d2.status === 200 && !d2.error && Array.isArray(d2.data) && d2.data.length === 0,
  `status=${d2.status} error=${d2.error ? d2.error.code : "null"} rows=${Array.isArray(d2.data) ? d2.data.length : typeof d2.data}`,
  { status: d2.status, error: d2.error, data: d2.data },
);

for (const table of [
  "checklist_seed_templates",
  "checklist_templates",
  "checklist_template_items",
  "submission_checklists",
  "submission_checklist_items",
  "submission_checklist_links",
  "submission_checklist_link_members",
]) {
  const r = await anon.from(table).select("*").limit(1);
  record(
    `A anon reads ${table}`,
    r.status === 401 && r.error?.code === "42501",
    `status=${r.status} code=${r.error ? r.error.code : "null"}`,
    { status: r.status, error: r.error },
  );
}

const generated = new Map();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(\+00:00|Z)?/g;
const json = JSON.stringify(
  {
    backlog: "BACKLOG-3473",
    captured_at: new Date().toISOString(),
    client: `@supabase/supabase-js ${SUPABASE_JS_VERSION}`,
    mode: expectRed ? "mutant: SELECT on checklist_templates revoked from authenticated" : "shipped migrations",
    note: "UUIDs replaced (fixture ids by <fixture:...>, generated by <generated-uuid-N>); timestamps by <timestamp>. Everything else verbatim.",
    cases: results,
  },
  null,
  2,
)
  .replace(UUID, (m) => {
    const k = m.toLowerCase();
    if (FIXTURE[k]) return FIXTURE[k];
    if (!generated.has(k)) generated.set(k, `<generated-uuid-${generated.size + 1}>`);
    return generated.get(k);
  })
  .replace(TIMESTAMP, "<timestamp>");

if (!expectRed) {
  mkdirSync(join(HERE, "..", "fixtures"), { recursive: true });
  const out = join(HERE, "..", "fixtures", "postgrest-desktop-read.json");
  writeFileSync(out, json + "\n");
  console.log(`wrote ${out}`);
}

const reds = results.filter((r) => !r.ok).map((r) => r.label);
if (expectRed) {
  const d1Red = reds.includes("D1 desktop read as P1's agent");
  console.log(d1Red ? "probe: D1 went RED under the mutant, as required" : "probe: D1 stayed GREEN under the mutant");
  process.exit(d1Red ? 0 : 1);
}
console.log(`probe: ${results.length - reds.length} green / ${results.length}`);
process.exit(reds.length === 0 ? 0 : 1);
