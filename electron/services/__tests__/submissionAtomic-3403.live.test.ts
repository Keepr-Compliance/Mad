/**
 * @jest-environment node
 *
 * BACKLOG-3403 PR-B — LIVE run of the desktop's submit path against a LOCAL
 * Supabase stack (real GoTrue, PostgREST, storage-api; the PR-A migration and
 * a 3725 stand-in applied). SKIPPED unless LIVE_3403B=1, so CI (no database)
 * never runs it. It refuses any URL that is not 127.0.0.1 / localhost.
 *
 * What is real: `submissionService`, `supabaseStorageService`,
 * `submissionAbandon`, supabase-js and every server rule. What is fixture: the
 * local SQLite reads (databaseService) and the files on disk (a temp dir).
 *
 *   LIVE_3403B=1 API_URL=… ANON_KEY=… SERVICE_ROLE_KEY=… PG_CONTAINER=… \
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/__tests__/submissionAtomic-3403.live.test.ts
 *
 * Recorded run: supabase/tests/backlog-3403b/live-run.txt.
 */
import * as fs from "fs";
import * as os from "os";
import * as nodePath from "path";
import { execFileSync } from "child_process";

const LIVE = process.env.LIVE_3403B === "1";
const API_URL = process.env.API_URL ?? "";
const ANON = process.env.ANON_KEY ?? "";
const SERVICE = process.env.SERVICE_ROLE_KEY ?? "";
const PG = process.env.PG_CONTAINER ?? "";
if (LIVE && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(API_URL)) {
  throw new Error("refusing: API_URL is not a local stack");
}

const ORG = "0e340300-0000-4000-8000-0000000000b1"; // pii-allow-uuid: invented fixture id
const BUCKET = "submission-attachments";
const TX = "txn-live-3403b";

type Row = Record<string, unknown>;
let agentClient: unknown = null;
let agentId = "";
/** fetch wrapper hooks: return a Response to short-circuit, or undefined to pass through. */
let intercept: ((url: string, init: RequestInit | undefined) => Promise<Response | undefined>) | null = null;

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => agentClient,
    getAuthSession: async () => ({ userId: agentId }),
  },
}));
jest.mock("../databaseService");
jest.mock("../logService");
jest.mock("../emailAttachmentService");
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../contactResolutionService", () => ({
  resolveHandles: jest.fn().mockResolvedValue({ names: {}, matches: {} }),
  extractParticipantHandles: jest.fn(() => []),
  nameForHandle: jest.fn(),
}));
jest.mock("../db/checklistDbService", () => ({
  getChecklistsForTransaction: async () => ({ checklists: [], requiredDone: 0, requiredTotal: 0 }),
}));
jest.mock("../db/submissionDbService", () => ({
  ...jest.requireActual("../db/submissionDbService"),
  getOwedReviewChecklistPullsFor: () => [],
}));
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("electron", () => ({
  app: { getVersion: () => "2.39.0", getPath: () => "/nonexistent" },
  net: { isOnline: () => false },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");
import { submissionService } from "../submissionService";
import databaseService from "../databaseService";
import { abandonSubmission } from "../submissionAbandon";
import { setStageRetryDelaysForTests } from "../submissionStageRetry";

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = LIVE ? createClient(API_URL, SERVICE, opts) : null;
const psql = (sql: string): string =>
  execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-tA", "-q"], { input: sql })
    .toString()
    .trim();
const lines: string[] = [];
const record = (s: string) => {
  lines.push(s);
};

let tmp = "";
const files: Record<string, string> = {};

function fixture(withBig = false) {
  const texts = [
    { id: "lt-1", channel: "imessage", direction: "inbound", sent_at: "2026-09-20T10:00:00Z", body_text: "photo", thread_id: "th-1", has_attachments: 1, participants: JSON.stringify({ from: "+15550100", to: ["me"] }) },
    { id: "lt-2", channel: "imessage", direction: "outbound", sent_at: "2026-09-20T11:00:00Z", body_text: "thanks", thread_id: "th-1", has_attachments: 0, participants: JSON.stringify({ from: "me", to: ["+15550100"] }) },
  ];
  const emails = [
    { id: "le-1", subject: "Inspection", sent_at: "2026-09-22T10:00:00Z", has_attachments: 1, direction: "inbound", sender: "a@example.test" },
  ];
  const attachments: Row[] = [
    { id: "la-photo", message_id: "lt-1", email_id: null, filename: "photo.jpg", storage_path: files.photo, mime_type: "image/jpeg" },
    { id: "la-pdf", message_id: null, email_id: "le-1", filename: "report.pdf", storage_path: files.pdf, mime_type: "application/pdf" },
  ];
  if (withBig) {
    attachments.push({ id: "la-big", message_id: null, email_id: "le-1", filename: "big.mov", storage_path: files.big, mime_type: "video/quicktime" });
  }
  (databaseService.getTransactionById as jest.Mock).mockResolvedValue({ id: TX, user_id: agentId, property_address: "1 Live Way", started_at: null, closed_at: null });
  (databaseService.getTransactionMessages as jest.Mock).mockReturnValue(texts);
  (databaseService.getTransactionEmails as jest.Mock).mockReturnValue(emails);
  (databaseService.getTransactionAttachments as jest.Mock).mockReturnValue(attachments);
  (databaseService.getUndownloadedEmailAttachments as jest.Mock).mockReturnValue([]);
  (databaseService.updateTransaction as jest.Mock).mockResolvedValue(undefined);
}

const countSubs = () => Number(psql(`select count(*) from public.transaction_submissions where local_transaction_id = '${TX}'`));
const objectsUnder = (sid: string) => Number(psql(`select count(*) from storage.objects where bucket_id = '${BUCKET}' and name like '${ORG}/${sid}/%'`));
const allObjects = () => Number(psql(`select count(*) from storage.objects where bucket_id = '${BUCKET}' and name like '${ORG}/%'`));
const reset = () => {
  // Service-side reset between cases: rows by SQL, files through the Storage API (SQL deletes are refused).
  psql(`delete from public.transaction_submissions where local_transaction_id = '${TX}';`);
};

(LIVE ? describe : describe.skip)("BACKLOG-3403 PR-B — live, local stack", () => {
  beforeAll(async () => {
    setStageRetryDelaysForTests([50]);
    tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "live-3403b-"));
    files.photo = nodePath.join(tmp, "photo.jpg");
    files.pdf = nodePath.join(tmp, "report.pdf");
    files.big = nodePath.join(tmp, "big.mov");
    fs.writeFileSync(files.photo, Buffer.from("JPEG live 3403b"));
    fs.writeFileSync(files.pdf, Buffer.from("%PDF-1.4 live 3403b"));
    fs.writeFileSync(files.big, Buffer.alloc(50 * 1024 * 1024 + 1, 1));

    const email = "live3403b-agent@example.test";
    const password = "Live-3403b-local-only";
    const { data: created } = await admin!.auth.admin.createUser({ email, password, email_confirm: true });
    agentId = created?.user?.id ?? (await admin!.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
    // Venue addition: PR-A's prelude transcribed only what its migration
    // touches; the desktop's membership read also orders on created_at, which
    // production has (submissionService.getUserOrganizationId).
    psql(`alter table public.organization_members add column if not exists created_at timestamptz not null default now();`);
    psql(`insert into public.organizations(id) values ('${ORG}') on conflict do nothing;
          delete from public.organization_members where organization_id = '${ORG}';
          insert into public.organization_members(organization_id, user_id, role) values ('${ORG}', '${agentId}', 'agent');`);
    const realFetch = globalThis.fetch;
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (intercept) {
        const r = await intercept(url, init);
        if (r) return r;
      }
      return realFetch(input as RequestInfo, init);
    };
    const c = createClient(API_URL, ANON, { ...opts, global: { fetch: wrapped as typeof fetch } });
    const { error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`sign in: ${error.message}`);
    agentClient = c;
  });

  afterEach(() => {
    intercept = null;
    reset();
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.writeFileSync(
      nodePath.join(__dirname, "..", "..", "..", "supabase", "tests", "backlog-3403b", "live-run.txt"),
      lines.join("\n").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>") + "\n"
    );
  });

  it("L1 normal submit: finalize flips it; rows, files and message_id are the manifest's", async () => {
    fixture();
    const r = await submissionService.submitTransaction(TX, undefined, { acceptedExclusionKeys: [] });
    const sid = r.submissionId as string;
    const row = psql(`select status||'|'||message_count||'|'||attachment_count||'|'||(submission_metadata->>'finalized_by') from public.transaction_submissions where id='${sid}'`);
    const links = psql(`select count(*) from public.submission_attachments a join public.submission_messages m on m.id=a.message_id where a.submission_id='${sid}'`);
    const attempt = psql(`select outcome from public.submission_attempts where submission_id='${sid}'`);
    record(`L1 success=${r.success} row=${row} objects=${objectsUnder(sid)} attachments_linked_to_their_message=${links} attempt=${attempt}`);
    expect(r.success).toBe(true);
    expect(row).toBe("submitted|3|2|finalize_submission");
    expect(objectsUnder(sid)).toBe(2);
    expect(links).toBe("2");
    expect(attempt).toBe("committed");
  });

  it("L2 a >50 MB file, confirmed: the rest is sent; excluded_files recorded; finalize does not count it", async () => {
    fixture(true);
    const pf = await submissionService.preflightSubmission(TX);
    const r = await submissionService.submitTransaction(TX, undefined, { acceptedExclusionKeys: pf.notIncluded.map((i) => i.key) });
    const sid = r.submissionId as string;
    const excluded = psql(`select submission_metadata->'excluded_files'->0->>'reason' || '|' || jsonb_array_length(submission_metadata->'excluded_files') from public.transaction_submissions where id='${sid}'`);
    record(`L2 preflight=${pf.notIncluded.map((i) => i.reason).join(",")} success=${r.success} status=${psql(`select status from public.transaction_submissions where id='${sid}'`)} excluded=${excluded} objects=${objectsUnder(sid)}`);
    expect(pf.notIncluded.map((i) => i.reason)).toEqual(["file_too_large"]);
    expect(r.success).toBe(true);
    expect(excluded).toBe("file_too_large|1");
    expect(objectsUnder(sid)).toBe(2);
  });

  it("L3 forced failure (message writes refused by the network): fence → files → rows; nothing left", async () => {
    fixture();
    const before = allObjects();
    intercept = async (url, init) =>
      url.includes("/rest/v1/submission_messages") && init?.method === "POST" ? Promise.reject(new TypeError("fetch failed")) : undefined;
    const r = await submissionService.submitTransaction(TX, undefined, { acceptedExclusionKeys: [] });
    const attempt = psql(`select outcome||'|'||stage||'|'||reason_code from public.submission_attempts order by started_at desc limit 1`);
    record(`L3 success=${r.success} error="${r.error}" submissions_left=${countSubs()} objects_added=${allObjects() - before} attempt=${attempt}`);
    expect(r.success).toBe(false);
    expect(countSubs()).toBe(0);
    expect(allObjects() - before).toBe(0);
    expect(attempt).toBe("failed|messages|retries_exhausted");
  });

  it("L4 forced failure AFTER the uploads (finalize refused twice): the uploaded files are removed through the Storage API", async () => {
    fixture();
    const before = allObjects();
    // Drop one message row out of band after it lands, twice — finalize refuses `incomplete` both times.
    let drops = 0;
    intercept = async (url, init) => {
      if (url.includes("/rest/v1/rpc/finalize_submission") && drops < 2) {
        drops += 1;
        const body = JSON.parse(String(init?.body ?? "{}"));
        // The message with no attachment (lt-2): deleting one an attachment
        // row points at would also null that row's link (ON DELETE SET NULL).
        psql(`delete from public.submission_messages where submission_id = '${body.p_submission_id}' and local_message_id = 'lt-2'`);
      }
      return undefined;
    };
    const r = await submissionService.submitTransaction(TX, undefined, { acceptedExclusionKeys: [] });
    record(`L4 success=${r.success} finalize_calls=${drops} submissions_left=${countSubs()} objects_added=${allObjects() - before}`);
    expect(r.success).toBe(false);
    expect(drops).toBe(2);
    expect(countSubs()).toBe(0);
    expect(allObjects() - before).toBe(0);
  });

  it("L5 refused once (a message row went missing), re-sent, finalized on the second call", async () => {
    fixture();
    let drops = 0;
    intercept = async (url, init) => {
      if (url.includes("/rest/v1/rpc/finalize_submission") && drops < 1) {
        drops += 1;
        const body = JSON.parse(String(init?.body ?? "{}"));
        // The message with no attachment (lt-2): deleting one an attachment
        // row points at would also null that row's link (ON DELETE SET NULL).
        psql(`delete from public.submission_messages where submission_id = '${body.p_submission_id}' and local_message_id = 'lt-2'`);
      }
      return undefined;
    };
    const r = await submissionService.submitTransaction(TX, undefined, { acceptedExclusionKeys: [] });
    const sid = r.submissionId as string;
    record(`L5 success=${r.success} status=${psql(`select status from public.transaction_submissions where id='${sid}'`)} messages=${psql(`select count(*) from public.submission_messages where submission_id='${sid}'`)} objects=${objectsUnder(sid)}`);
    expect(r.success).toBe(true);
    expect(objectsUnder(sid)).toBe(2);
  });

  it("L6 finalize's answer lost: the read-back sees the commit → success, nothing deleted", async () => {
    fixture();
    let lost = false;
    intercept = async (url, init) => {
      if (url.includes("/rest/v1/rpc/finalize_submission") && !lost) {
        lost = true;
        await (globalThis.fetch as typeof fetch)(url, init); // the server commits…
        return Promise.reject(new TypeError("fetch failed")); // …and the answer never arrives
      }
      return undefined;
    };
    const r = await submissionService.submitTransaction(TX, undefined, { acceptedExclusionKeys: [] });
    const sid = r.submissionId as string;
    record(`L6 success=${r.success} status=${psql(`select status from public.transaction_submissions where id='${sid}'`)} objects=${objectsUnder(sid)}`);
    expect(r.success).toBe(true);
    expect(objectsUnder(sid)).toBe(2);
  });

  it("L7 Cancel during the uploads: nothing left", async () => {
    fixture();
    const before = allObjects();
    intercept = async (url) => {
      if (url.includes(`/storage/v1/object/${BUCKET}/`)) submissionService.cancelSubmission(TX);
      return undefined;
    };
    const r = await submissionService.submitTransaction(TX, undefined, { acceptedExclusionKeys: [] });
    const attempt = psql(`select outcome from public.submission_attempts order by started_at desc limit 1`);
    record(`L7 success=${r.success} cancelled=${r.cancelled} submissions_left=${countSubs()} objects_added=${allObjects() - before} attempt=${attempt}`);
    expect(r.cancelled).toBe(true);
    expect(countSubs()).toBe(0);
    expect(allObjects() - before).toBe(0);
    expect(attempt).toBe("cancelled");
  });

  it("L8 the race: finalize holds the row; the desktop's fence waits, finds it committed, deletes nothing", async () => {
    fixture();
    // Build an uploading submission with its files through the real flow, stopped before finalize.
    let sid = "";
    intercept = async (url, init) => {
      if (url.includes("/rest/v1/rpc/finalize_submission")) {
        sid = JSON.parse(String(init?.body ?? "{}")).p_submission_id;
        return new Response(JSON.stringify({ code: "XX000", message: "stop here" }), { status: 400 });
      }
      if (url.includes("/rest/v1/transaction_submissions") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ code: "XX000", message: "no fence in setup" }), { status: 400 });
      }
      return undefined;
    };
    await submissionService.submitTransaction(TX, undefined, { acceptedExclusionKeys: [] });
    intercept = null;
    const paths = psql(`select string_agg(storage_path, ',') from public.submission_attachments where submission_id='${sid}'`).split(",");
    expect(psql(`select status from public.transaction_submissions where id='${sid}'`)).toBe("uploading");
    // Session 1: a finalize-like transaction holds the row lock for 3 s, then commits `submitted`.
    const { spawn } = await import("child_process");
    const holder = spawn("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-X", "-q"], { stdio: ["pipe", "ignore", "ignore"] });
    const holderDone = new Promise((res) => holder.on("exit", res));
    holder.stdin.write(`BEGIN; SELECT id FROM public.transaction_submissions WHERE id='${sid}' FOR UPDATE; SELECT pg_sleep(3); UPDATE public.transaction_submissions SET status='submitted' WHERE id='${sid}'; COMMIT;\n`);
    holder.stdin.end();
    await new Promise((res) => setTimeout(res, 700));
    // Session 2: the desktop's abandon (fence first).
    const t0 = Date.now();
    const out = await abandonSubmission(agentClient as never, sid, paths);
    const waited = Date.now() - t0;
    await holderDone;
    record(`L8 abandon=${out.outcome} status_read=${out.status} waited_ms>=2000:${waited >= 2000} status_now=${psql(`select status from public.transaction_submissions where id='${sid}'`)} objects=${objectsUnder(sid)} rows=${psql(`select count(*) from public.submission_attachments where submission_id='${sid}'`)}`);
    expect(out.outcome).toBe("committed");
    expect(waited).toBeGreaterThanOrEqual(2000);
    expect(objectsUnder(sid)).toBe(paths.length);
  }, 60000);
});
