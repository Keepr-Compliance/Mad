/**
 * @jest-environment node
 *
 * BACKLOG-3403 (with 3398, 3681, 3682) — a submission is all or nothing.
 *
 * WHAT THIS SUITE HOLDS
 *
 * The desktop writes the parent row, messages and attachment rows (each with
 * an id it minted, so a retry inserts nothing twice), uploads the files, and
 * asks `finalize_submission` to flip the status. Only the server's answer may
 * make the deal "submitted", locally or remotely. Every failure goes through
 * one cleanup: the FENCE first, then files, then rows.
 *
 * THE FAKE
 *
 * `FakeCloud` is transcribed, not invented:
 *  - finalize_submission's branches and refusal counters from
 *    supabase/migrations/20261004192647_backlog_3403_finalize_submission.sql
 *    :237-302 (codes not_found / not_owner / not_uploading / abandoned /
 *    incomplete, the id-set compare at :248-253, the attachment checks at
 *    :255-270, the checklist count at :272-274);
 *  - the fence and the delete rules from the same file's policies (:333-341
 *    attachment-row delete; :361-377 storage delete) with BACKLOG-3725's
 *    column `abandoned_at` in place of the jsonb flag
 *    (20261004220000_backlog_3725_abandoned_at.sql, PR #2795);
 *  - the insert rules :312-331 (rows only while `uploading`; an attachment
 *    path must sit in `{org}/{submission}/`);
 *  - ON CONFLICT (id) DO NOTHING = supabase-js `upsert(…, {ignoreDuplicates})`
 *    (PR-A live run, 88c8c300: retried upserts → no error, one row);
 *  - a network failure as postgrest-js returns it: `{ code: "", message:
 *    "TypeError: fetch failed" }` (see submissionChecklistSnapshot-3477);
 *  - PGRST202 from supabase/tests/backlog-3403/live/pgrst202.json (code only).
 *
 * Runner: ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *           --bail=0 electron/services/__tests__/submissionAtomic-3403.test.ts
 */

import * as fs from "fs";
import * as nodePath from "path";

type Row = Record<string, unknown>;
type PgError = { code: string; message: string };

const ORG = "11111111-1111-4111-8111-000000003403"; // pii-allow-uuid: invented fixture id
const USER = "22222222-2222-4222-8222-000000003403"; // pii-allow-uuid: invented fixture id
const TX = "txn-3403";
const NETWORK: PgError = { code: "", message: "TypeError: fetch failed" };
/** The supabase-js error object PR-A's live run captured (match on `code` only). */
const PGRST202 = (
  JSON.parse(
    fs.readFileSync(
      nodePath.join(__dirname, "..", "..", "..", "supabase", "tests", "backlog-3403", "live", "pgrst202.json"),
      "utf8"
    )
  ) as { supabase_js: { error: Record<string, unknown> } }
).supabase_js.error;

// ============================================================================
// FAKE CLOUD
// ============================================================================

type Op = "insert" | "update" | "delete" | "select";
type Script = "network" | "lost" | "phantom" | PgError;

class FakeCloud {
  tables: Record<string, Row[]> = {
    transaction_submissions: [],
    submission_messages: [],
    submission_attachments: [],
    submission_checklists: [],
    organization_members: [{ id: "m-1", user_id: USER, organization_id: ORG, created_at: "2026-01-01T00:00:00Z" }],
    error_logs: [],
  };
  objects = new Set<string>();
  /** Every call issued, in order, for "what happened" assertions. */
  calls: { kind: string; table?: string; op?: Op; fn?: string; detail?: unknown }[] = [];
  /**
   * Per "table:op", what the next calls do: `network` (no commit, error),
   * `lost` (commits, then the answer is a network error), `phantom` (answers
   * OK, stores nothing), or a Postgres error.
   */
  script: Record<string, Script[]> = {};
  /** finalize_submission scripted answers, consumed in order. */
  finalizeScript: Array<"network" | "lost" | "refuse_incomplete" | PgError | "pgrst202"> = [];
  /** A finalize that committed server-side while the client stopped listening. */
  pendingFinalize: (() => void) | null = null;
  attemptCalls: Row[] = [];
  snapshotPhantoms = 0;
  /** C4: the next N storage removes answer with a network error. */
  removeFailures = 0;

  private take(key: string): Script | undefined {
    const q = this.script[key];
    return q && q.length > 0 ? q.shift() : undefined;
  }

  private parentOf(submissionId: unknown): Row | undefined {
    return this.tables.transaction_submissions.find((s) => s.id === submissionId);
  }

  /** RLS INSERT (:312-331). */
  private mayInsert(table: string, rec: Row): boolean {
    if (table === "transaction_submissions") return rec.submitted_by === USER;
    if (table === "submission_messages") {
      const p = this.parentOf(rec.submission_id);
      return !!p && p.submitted_by === USER && p.status === "uploading";
    }
    if (table === "submission_attachments") {
      const p = this.parentOf(rec.submission_id);
      const parts = String(rec.storage_path ?? "").split("/");
      return !!p && p.submitted_by === USER && p.status === "uploading" &&
        parts[0] === p.organization_id && parts[1] === p.id;
    }
    return true;
  }

  /** RLS DELETE (:333-341 with 3725's column; stale-upload policy for parents). */
  private mayDelete(table: string, row: Row): boolean {
    if (table === "transaction_submissions") return row.submitted_by === USER && row.status === "uploading";
    if (table === "submission_attachments") {
      const p = this.parentOf(row.submission_id);
      return !!p && p.submitted_by === USER && p.status === "uploading" && !!p.abandoned_at;
    }
    if (table === "submission_messages") return false; // no agent DELETE policy
    return true;
  }

  storage = {
    from: (_bucket: string) => ({
      // Storage DELETE policy (:361-377): the parent row must exist, be the
      // caller's, `uploading`, and fenced. Rows deleted first → nothing.
      remove: async (paths: string[]) => {
        this.calls.push({ kind: "storage.remove", detail: [...paths] });
        if (this.removeFailures > 0) {
          this.removeFailures -= 1;
          return { data: null, error: { name: "StorageUnknownError", message: "fetch failed" } };
        }
        const gone: string[] = [];
        for (const p of paths) {
          const parts = p.split("/");
          const parent = this.parentOf(parts[1]);
          if (parent && parent.organization_id === parts[0] && parent.submitted_by === USER &&
              parent.status === "uploading" && parent.abandoned_at && this.objects.delete(p)) {
            gone.push(p);
          }
        }
        return { data: gone.map((name) => ({ name })), error: null };
      },
    }),
  };

  from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: Op = "select";
    let payload: Row | Row[] | null = null;
    let ignoreDup = false;
    let single: "maybe" | "single" | null = null;
    const all = () => this.tables[table];
    const matched = () => all().filter((r) => filters.every((f) => f(r)));

    const run = (): { data: unknown; error: PgError | null } => {
      this.calls.push({ kind: "from", table, op });
      const scripted = this.take(`${table}:${op}`);
      if (scripted && typeof scripted === "object") return { data: null, error: scripted };
      if (scripted === "network") return { data: null, error: NETWORK };
      if (op === "select") {
        const rows = matched();
        if (single === "maybe") return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      }
      if (op === "update") {
        const hit = matched().filter(
          (r) => table !== "transaction_submissions" || (r.submitted_by === USER && r.status === "uploading")
        );
        for (const r of hit) Object.assign(r, payload as Row);
        return scripted === "lost" ? { data: null, error: NETWORK } : { data: hit, error: null };
      }
      if (op === "delete") {
        const hit = matched().filter((r) => this.mayDelete(table, r));
        this.tables[table] = all().filter((r) => !hit.includes(r));
        if (table === "transaction_submissions") {
          const ids = hit.map((r) => r.id);
          for (const child of ["submission_messages", "submission_attachments", "submission_checklists"]) {
            this.tables[child] = this.tables[child].filter((c) => !ids.includes(c.submission_id));
          }
        }
        return { data: hit, error: null };
      }
      // insert / upsert
      const incoming = Array.isArray(payload) ? payload : [payload as Row];
      if (scripted !== "phantom") {
        for (const rec of incoming) {
          if (!this.mayInsert(table, rec)) {
            return { data: null, error: { code: "42501", message: `new row violates row-level security policy for table "${table}"` } };
          }
          if (all().some((r) => r.id === rec.id)) {
            if (ignoreDup) continue;
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          all().push({ ...rec });
        }
      }
      return scripted === "lost" ? { data: null, error: NETWORK } : { data: null, error: null };
    };

    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Row | Row[]) => ((op = "insert"), (payload = p), b),
      upsert: (p: Row | Row[], o?: { ignoreDuplicates?: boolean }) =>
        ((op = "insert"), (payload = p), (ignoreDup = o?.ignoreDuplicates === true), b),
      update: (p: Row) => ((op = "update"), (payload = p), b),
      delete: () => ((op = "delete"), b),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      is: (c: string, v: unknown) => (filters.push((r) => (v === null ? r[c] == null : r[c] === v)), b),
      order: () => b,
      limit: () => b,
      maybeSingle: () => ((single = "maybe"), Promise.resolve(run())),
      single: () => {
        const r = run();
        const rows = r.data as Row[];
        return Promise.resolve(rows?.length === 1 ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } });
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  }

  /** finalize_submission, transcribed (:237-302). */
  private finalize(args: Row): { data: unknown; error: PgError | null } {
    const id = args.p_submission_id;
    const manifest = args.p_manifest as {
      message_ids: string[];
      attachments: { id: string; storage_path: string; message_id: string | null }[];
      checklists: number | null;
    };
    const sub = this.parentOf(id);
    if (!sub) return { data: { ok: false, code: "not_found" }, error: null };
    if (sub.submitted_by !== USER) return { data: { ok: false, code: "not_owner" }, error: null };
    const target = sub.parent_submission_id ? "resubmitted" : "submitted";
    if (sub.status === target) return { data: { ok: true, already_final: true, status: target }, error: null };
    if (sub.status !== "uploading") return { data: { ok: false, code: "not_uploading" }, error: null };
    if (sub.abandoned_at) return { data: { ok: false, code: "abandoned" }, error: null };

    const msgs = new Set(manifest.message_ids);
    const stored = this.tables.submission_messages.filter((m) => m.submission_id === id);
    const messages_missing = [...msgs].filter((m) => !stored.some((s) => s.id === m)).length;
    const messages_extra = stored.filter((s) => !msgs.has(s.id as string)).length;
    const prefix = `${sub.organization_id}/${id}/`;
    const rows = this.tables.submission_attachments.filter((a) => a.submission_id === id);
    let attachment_rows_missing = 0, links = 0, outside = 0, objects_missing = 0;
    for (const d of manifest.attachments) {
      const r = rows.find((x) => x.id === d.id);
      if (!r || r.storage_path !== d.storage_path) attachment_rows_missing += 1;
      if (r && ((r.message_id ?? null) !== (d.message_id ?? null) || (d.message_id && !msgs.has(d.message_id)))) links += 1;
      if (!d.storage_path || !d.storage_path.startsWith(prefix)) outside += 1;
      if (!this.objects.has(d.storage_path)) objects_missing += 1;
    }
    const attachment_rows_extra = rows.filter((r) => !manifest.attachments.some((d) => d.id === r.id)).length;
    const expected = manifest.checklists;
    const found = expected === null ? 0 : this.tables.submission_checklists.filter((c) => c.submission_id === id).length;
    if (messages_missing + messages_extra + attachment_rows_missing + attachment_rows_extra + objects_missing + outside + links > 0 ||
        (expected !== null && found !== expected)) {
      return {
        data: {
          ok: false, code: "incomplete", messages_missing, messages_extra, attachment_rows_missing,
          attachment_rows_extra, objects_missing, paths_outside_submission: outside,
          attachment_message_links_wrong: links, checklists_expected: expected, checklists_found: found,
        },
        error: null,
      };
    }
    sub.status = target;
    sub.message_count = msgs.size;
    sub.attachment_count = new Set(manifest.attachments.map((a) => a.id)).size;
    return { data: { ok: true, already_final: false, status: target }, error: null };
  }

  rpc(fn: string, args: Row): Promise<{ data: unknown; error: unknown }> {
    this.calls.push({ kind: "rpc", fn });
    if (fn === "record_submission_attempt") {
      this.attemptCalls.push(args);
      return Promise.resolve({ data: { ok: true, outcome: args.p_outcome, unchanged: false }, error: null });
    }
    if (fn === "snapshot_submission_checklists") {
      const list = args.p_checklists as Row[];
      if (this.snapshotPhantoms > 0) {
        this.snapshotPhantoms -= 1;
        return Promise.resolve({ data: { checklists: list.length, items: 0, links: 0, members: 0, dropped_members: 0, dropped_links: 0 }, error: null });
      }
      if (this.tables.submission_checklists.some((c) => c.submission_id === args.p_submission_id) && list.length > 0) {
        return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
      }
      for (const c of list) {
        this.tables.submission_checklists.push({ id: `scl-${Math.random()}`, submission_id: args.p_submission_id, template_name: c.template_name });
      }
      return Promise.resolve({ data: { checklists: list.length, items: 0, links: 0, members: 0, dropped_members: 0, dropped_links: 0 }, error: null });
    }
    if (fn === "finalize_submission") {
      const s = this.finalizeScript.shift();
      if (s === "pgrst202") return Promise.resolve({ data: null, error: { ...PGRST202 } });
      if (s === "network") return Promise.resolve({ data: null, error: NETWORK });
      if (s && typeof s === "object") return Promise.resolve({ data: null, error: s });
      if (s === "refuse_incomplete") {
        return Promise.resolve({ data: { ok: false, code: "incomplete", messages_missing: 1, messages_extra: 0, attachment_rows_missing: 0, attachment_rows_extra: 0, objects_missing: 0, paths_outside_submission: 0, attachment_message_links_wrong: 0, checklists_expected: null, checklists_found: 0 }, error: null });
      }
      if (s === "lost") {
        // Still running when the client gives up; commits when the next
        // statement that would wait on its row lock arrives (the fence).
        this.pendingFinalize = () => this.finalize(args);
        return Promise.resolve({ data: null, error: NETWORK });
      }
      return Promise.resolve(this.finalize(args));
    }
    return Promise.resolve({ data: null, error: { code: "42883", message: `function ${fn} does not exist` } });
  }
}

// ============================================================================
// MOCKS
// ============================================================================

let cloud: FakeCloud;
let checklistsForTx: Row = { checklists: [], requiredDone: 0, requiredTotal: 0 };

jest.mock("../supabaseService");
jest.mock("../supabaseStorageService");
jest.mock("../databaseService");
jest.mock("../logService");
jest.mock("../emailAttachmentService");
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../contactResolutionService", () => ({
  resolveHandles: jest.fn().mockResolvedValue({ names: { "+15550100": "Jane Fixture" }, matches: {} }),
  extractParticipantHandles: jest.fn(() => []),
  nameForHandle: jest.fn((res: { names: Record<string, string> }, h: string) => res.names[h]),
}));
jest.mock("../db/checklistDbService", () => ({
  getChecklistsForTransaction: async () => checklistsForTx,
}));
jest.mock("../db/submissionDbService", () => ({
  ...jest.requireActual("../db/submissionDbService"),
  getOwedReviewChecklistPullsFor: () => [],
}));
jest.mock("electron", () => ({
  app: { getVersion: jest.fn().mockReturnValue("2.39.0"), getPath: jest.fn(() => "/nonexistent") },
  net: { isOnline: () => false },
}));

import { submissionService, SUBMISSION_NOT_SENT_ERROR, SUBMISSION_CANCELLED_MESSAGE, SUBMISSION_UNCONFIRMED_ERROR } from "../submissionService";
import supabaseService from "../supabaseService";
import supabaseStorageService from "../supabaseStorageService";
import databaseService from "../databaseService";
import { buildAttachmentStoragePath } from "../submissionAttachmentFiles";
import { setPreflightStatForTests } from "../submissionPreflight";
import { setStageRetryDelaysForTests } from "../submissionStageRetry";
import { installErrorReporter, resetErrorReporter } from "../../capabilities/errorReporterProvider";
import type { ErrorReporter } from "../../capabilities/errorReporter";

// ============================================================================
// FIXTURE — two texts (one with a photo), one email with a PDF
// ============================================================================

const TEXTS = [
  { id: "msg-1", channel: "imessage", direction: "inbound", sent_at: "2026-09-20T10:00:00Z", body_text: "Here is the photo", thread_id: "th-1", has_attachments: 1, participants: JSON.stringify({ from: "+15550100", to: ["me"] }) },
  { id: "msg-2", channel: "imessage", direction: "outbound", sent_at: "2026-09-21T10:00:00Z", body_text: "Thanks", thread_id: "th-1", has_attachments: 0, participants: JSON.stringify({ from: "me", to: ["+15550100"] }) },
];
const EMAILS = [
  { id: "em-1", subject: "Inspection report", sent_at: "2026-09-22T10:00:00Z", has_attachments: 1, direction: "inbound", sender: "inspector@example.test" },
];
const ATTACHMENTS = [
  { id: "att-photo", message_id: "msg-1", resolved_message_id: "msg-1", email_id: null, filename: "IMG_0001.jpg", storage_path: "/local/IMG_0001.jpg", mime_type: "image/jpeg", created_at: "2026-09-20T10:00:00Z" },
  { id: "att-pdf", message_id: null, email_id: "em-1", filename: "Inspection.pdf", storage_path: "/local/Inspection.pdf", mime_type: "application/pdf", created_at: "2026-09-22T10:00:00Z" },
];

let uploadScript: Array<"fail"> = [];
const captured: { message: string; level?: string; tags?: unknown; extra?: unknown }[] = [];
const reporter: ErrorReporter = {
  captureException: () => undefined,
  captureMessage: (message: string, options?: { level?: string; tags?: unknown; extra?: unknown }) => {
    captured.push({ message, level: options?.level, tags: options?.tags, extra: options?.extra });
  },
  addBreadcrumb: () => undefined,
  flush: async () => true,
  setUser: () => undefined,
} as unknown as ErrorReporter;

let localTx: Row;

beforeEach(() => {
  jest.clearAllMocks();
  cloud = new FakeCloud();
  captured.length = 0;
  uploadScript = [];
  checklistsForTx = { checklists: [], requiredDone: 0, requiredTotal: 0 };
  installErrorReporter(reporter);
  setStageRetryDelaysForTests([0]);
  setPreflightStatForTests(async () => ({ size: 2048 }));
  (supabaseService.getClient as jest.Mock).mockImplementation(() => cloud);
  (supabaseService.getAuthSession as jest.Mock).mockResolvedValue({ userId: USER });
  localTx = { id: TX, user_id: USER, property_address: "1 Fixture Way", started_at: null, closed_at: null, submission_status: "not_submitted", submission_id: null };
  (databaseService.getTransactionById as jest.Mock).mockImplementation(async () => ({ ...localTx }));
  (databaseService.getTransactionMessages as jest.Mock).mockReturnValue(TEXTS);
  (databaseService.getTransactionEmails as jest.Mock).mockReturnValue(EMAILS);
  (databaseService.getTransactionAttachments as jest.Mock).mockReturnValue(ATTACHMENTS);
  (databaseService.getUndownloadedEmailAttachments as jest.Mock).mockReturnValue([]);
  (databaseService.updateTransaction as jest.Mock).mockImplementation(async (_id: string, u: Row) => {
    Object.assign(localTx, u);
  });
  (supabaseStorageService.uploadAttachmentWithRetry as jest.Mock).mockImplementation(
    async (org: string, sub: string, id: string, localPath: string, filename: string) => {
      cloud.calls.push({ kind: "upload", detail: id });
      if (uploadScript.shift() === "fail") {
        return { localId: localPath, storagePath: "", success: false, error: "fetch failed" };
      }
      const storagePath = buildAttachmentStoragePath(org, sub, id, filename);
      cloud.objects.add(storagePath);
      return { localId: localPath, storagePath, success: true };
    }
  );
});

afterEach(() => {
  resetErrorReporter();
  setPreflightStatForTests(null);
  setStageRetryDelaysForTests([1000, 2000]);
});

const submit = () => submissionService.submitTransaction(TX, undefined, { acceptedExclusionKeys: [] });
const subRows = () => cloud.tables.transaction_submissions;
const localStatusWrites = () =>
  (databaseService.updateTransaction as jest.Mock).mock.calls.filter((c) => "submission_status" in (c[1] as Row));
const failureEvents = () => captured.filter((e) => e.message === "Submission failed");

/** No name, subject, file name, path or phone number anywhere in a Sentry payload. */
function expectNoPii(): void {
  const blob = JSON.stringify(captured);
  for (const forbidden of ["Jane", "+1555", "Inspection", "IMG_0001", "/local/", "Fixture Way", "fetch failed", "duplicate key"]) {
    expect({ forbidden, found: blob.includes(forbidden) }).toEqual({ forbidden, found: false });
  }
}

/** Nothing of this attempt is left in the cloud. */
function expectNothingLeft(): void {
  expect(subRows()).toEqual([]);
  expect(cloud.tables.submission_messages).toEqual([]);
  expect(cloud.tables.submission_attachments).toEqual([]);
  expect([...cloud.objects]).toEqual([]);
}

// ============================================================================
// THE HAPPY PATH
// ============================================================================

describe("BACKLOG-3403 — a complete submission", () => {
  it("writes everything under minted ids, then the SERVER flips the status; the local status is the server's", async () => {
    const result = await submit();

    expect(result).toMatchObject({ success: true, messagesCount: 3, attachmentsCount: 2, notIncluded: [] });
    expect(subRows()).toHaveLength(1);
    expect(subRows()[0]).toMatchObject({ id: result.submissionId, status: "submitted", message_count: 3, attachment_count: 2 });
    // Order: parent → messages → attachment rows → uploads → snapshot → finalize.
    const order = cloud.calls
      .filter((c) => (c.kind === "from" && c.op === "insert") || c.kind === "upload" || (c.kind === "rpc" && c.fn !== "record_submission_attempt"))
      .map((c) => c.table ?? c.fn ?? c.kind);
    expect(order).toEqual([
      "transaction_submissions", "submission_messages", "submission_attachments",
      "upload", "upload", "snapshot_submission_checklists", "finalize_submission",
    ]);
    expect(localTx).toMatchObject({ submission_status: "submitted", submission_id: result.submissionId });
  });

  /**
   * D9 / BACKLOG-3682: each attachment row names its source message by the
   * cloud id minted for it — a text's photo and an email's PDF.
   * MUTATION: write `message_id: null` → both red.
   */
  it("D9: a text's photo and an email's PDF each carry their own message_id", async () => {
    const result = await submit();
    expect(result.success).toBe(true);
    const msgByLocal = new Map(cloud.tables.submission_messages.map((m) => [m.local_message_id, m.id]));
    const att = new Map(cloud.tables.submission_attachments.map((a) => [a.local_attachment_id, a]));
    expect(att.get("att-photo")?.message_id).toBe(msgByLocal.get("msg-1"));
    expect(att.get("att-pdf")?.message_id).toBe(msgByLocal.get("em-1"));
    expect(msgByLocal.get("msg-1")).not.toBe(msgByLocal.get("em-1"));
  });

  /**
   * BACKLOG-3731: a text photo whose stored `message_id` is stale (the shared
   * lookup found it by the text's Apple id) is linked to the text it RESOLVED
   * to, not to the stale id.
   * MUTATION: ownerKey on `row.message_id` → message_id null → red.
   */
  it("D9 (3731): a photo found by the Apple id is linked to its resolved text", async () => {
    (databaseService.getTransactionAttachments as jest.Mock).mockReturnValue([
      { ...ATTACHMENTS[0], message_id: "gone-id", resolved_message_id: "msg-1" },
      ATTACHMENTS[1],
    ]);
    const result = await submit();
    expect(result).toMatchObject({ success: true, notIncluded: [] });
    const msgByLocal = new Map(cloud.tables.submission_messages.map((m) => [m.local_message_id, m.id]));
    const att = new Map(cloud.tables.submission_attachments.map((a) => [a.local_attachment_id, a]));
    expect(msgByLocal.get("msg-1")).toBeDefined();
    expect(att.get("att-photo")?.message_id).toBe(msgByLocal.get("msg-1"));
  });

  /**
   * D7: a batch whose answer was lost is retried with the SAME ids, so the
   * retry inserts nothing twice and finalize's id-set compare passes.
   * MUTATION: mint a new id per attempt → duplicate rows → refused twice →
   * not sent.
   */
  it("D7: a lost answer on the message batch is retried with the same ids — no duplicates", async () => {
    cloud.script["submission_messages:insert"] = ["lost"];
    const result = await submit();
    expect(result.success).toBe(true);
    expect(cloud.tables.submission_messages).toHaveLength(3);
    expect(new Set(cloud.tables.submission_messages.map((m) => m.id)).size).toBe(3);
  });

  it("the stale `uploading` row of an earlier attempt is fenced and cleared — files first — before the new row", async () => {
    const staleId = "33333333-3333-4333-8333-000000003403"; // pii-allow-uuid: invented fixture id
    const stalePath = `${ORG}/${staleId}/att-old/old.pdf`;
    cloud.tables.transaction_submissions.push({ id: staleId, organization_id: ORG, submitted_by: USER, local_transaction_id: TX, status: "uploading", version: 1 });
    cloud.tables.submission_attachments.push({ id: "a-old", submission_id: staleId, storage_path: stalePath });
    cloud.objects.add(stalePath);

    const result = await submit();

    expect(result.success).toBe(true);
    expect(subRows().map((s) => s.id)).toEqual([result.submissionId]);
    expect(cloud.objects.has(stalePath)).toBe(false);
  });
});

describe("BACKLOG-3403 — an earlier attempt that was fenced but never cleared", () => {
  /**
   * A crash (or a lost network) between the fence and the deletes leaves an
   * `uploading` row with `abandoned_at` set. Only its submitter can set that
   * (3725 trigger) and finalize refuses it, so it can never commit. The sweep
   * finishes the cleanup; otherwise every later submit of this deal collides
   * on the version ("already has a submission at this version").
   * MUTATION: drop `finishEarlierAbandon` → the collision → red.
   */
  it("the sweep finishes it — files first — and the new submission goes through", async () => {
    const staleId = "44444444-4444-4444-8444-000000003403"; // pii-allow-uuid: invented fixture id
    const stalePath = `${ORG}/${staleId}/att-old/old.pdf`;
    cloud.tables.transaction_submissions.push({ id: staleId, organization_id: ORG, submitted_by: USER, local_transaction_id: TX, status: "uploading", version: 1, abandoned_at: "2026-10-04T10:00:00Z" });
    cloud.tables.submission_attachments.push({ id: "a-old", submission_id: staleId, storage_path: stalePath });
    cloud.objects.add(stalePath);

    const result = await submit();

    expect(result.success).toBe(true);
    expect(subRows().map((s) => s.id)).toEqual([result.submissionId]);
    expect(cloud.objects.has(stalePath)).toBe(false);
  });

  it("a fenced row is never finished by the FAILURE path (only the sweep may)", async () => {
    // The failure path's 0-row fence on its own row means committed or a
    // concurrent abandon: it deletes nothing (SR condition 1).
    cloud.finalizeScript = [{ code: "42501", message: "permission denied" }];
    const realFrom = cloud.from.bind(cloud);
    jest.spyOn(cloud, "from").mockImplementation((table: string) => {
      const b = realFrom(table) as Record<string, (...a: unknown[]) => unknown>;
      const realUpdate = b.update;
      b.update = (p: unknown) => {
        // Another path fenced it first.
        if (table === "transaction_submissions") for (const s of subRows()) s.abandoned_at = "2026-10-04T10:00:00Z";
        return realUpdate(p);
      };
      return b as never;
    });
    const result = await submit();
    expect(result.success).toBe(false);
    expect(cloud.calls.filter((c) => c.kind === "storage.remove")).toEqual([]);
    expect(subRows()).toHaveLength(1);
  });
});

// ============================================================================
// FAILURES — everything is removed, the agent is told, local state untouched
// ============================================================================

describe("BACKLOG-3403 — a failed stage sends nothing", () => {
  /**
   * D1. Pre-change, a failed message batch only WARNED and the submission
   * finalized without it (plan X1: zero existing tests saw it).
   * MUTATION: warn instead of throw in insertMessagesBatched → red.
   */
  it("D1: message writes that fail 3 times → not sent, fenced and removed, one Sentry error with counts only", async () => {
    cloud.script["submission_messages:insert"] = ["network", "network", "network"];

    const result = await submit();

    expect(result).toMatchObject({ success: false, submissionId: null, error: SUBMISSION_NOT_SENT_ERROR });
    expectNothingLeft();
    expect(localStatusWrites()).toEqual([]);
    expect(cloud.calls.some((c) => c.fn === "finalize_submission")).toBe(false);
    expect(failureEvents()).toHaveLength(1);
    expect(failureEvents()[0]).toMatchObject({ level: "error", tags: { area: "submission", stage: "messages", reason: "retries_exhausted" } });
    expectNoPii();
    const ended = cloud.attemptCalls.filter((a) => a.p_outcome !== "in_progress");
    expect(ended.map((a) => [a.p_outcome, a.p_stage, a.p_reason_code])).toEqual([["failed", "messages", "retries_exhausted"]]);
  });

  /** D2 (plan X2: zero tests saw a failed attachment-row write). MUTATION: warn, don't throw → red. */
  it("D2: attachment-row writes that fail → not sent, everything removed", async () => {
    cloud.script["submission_attachments:insert"] = ["network", "network", "network"];
    const result = await submit();
    expect(result).toMatchObject({ success: false, error: SUBMISSION_NOT_SENT_ERROR });
    expectNothingLeft();
    expect(localStatusWrites()).toEqual([]);
    expect(failureEvents()[0]).toMatchObject({ tags: { stage: "attachment_rows" } });
    expectNoPii();
  });

  it("a permanent refusal (42501) is not retried and sends nothing", async () => {
    cloud.script["submission_messages:insert"] = [{ code: "42501", message: "new row violates row-level security policy" }];
    const result = await submit();
    expect(result).toMatchObject({ success: false, error: SUBMISSION_NOT_SENT_ERROR });
    expect(cloud.calls.filter((c) => c.table === "submission_messages" && c.op === "insert")).toHaveLength(1);
    expect(failureEvents()[0]).toMatchObject({ tags: { reason: "permanent_error" }, extra: expect.objectContaining({ error_code: "42501" }) });
    expectNothingLeft();
  });

  /** D3. MUTATION: skip a failed upload instead of throwing → finalize refuses / or succeeds short. */
  it("D3: a file that fails to upload fails the submission — no 'submitted without 1 attachment'", async () => {
    uploadScript = ["fail"];
    const result = await submit();
    expect(result).toMatchObject({ success: false, error: SUBMISSION_NOT_SENT_ERROR });
    expect(cloud.calls.some((c) => c.fn === "finalize_submission")).toBe(false);
    expectNothingLeft();
  });

  /**
   * D6: files before rows. The storage delete policy reads the parent row, so
   * deleting rows first leaves every file undeletable.
   * MUTATION: delete rows, then files → objects remain → red.
   */
  it("D6: cleanup removes the files BEFORE the rows (or the files could never be removed)", async () => {
    cloud.finalizeScript = [{ code: "42501", message: "permission denied" }];
    const result = await submit();
    expect(result.success).toBe(false);
    expect([...cloud.objects]).toEqual([]);
    const seq = cloud.calls
      .filter((c) => c.kind === "storage.remove" || (c.kind === "from" && c.op === "delete" && c.table !== "error_logs") || (c.kind === "from" && c.op === "update"))
      .map((c) => (c.kind === "storage.remove" ? "files" : `${c.op}:${c.table}`));
    expect(seq).toEqual(["update:transaction_submissions", "files", "delete:submission_attachments", "delete:transaction_submissions"]);
  });

  /** D14: no finalize function on this database → permanent, plain words, removed. */
  it("D14: PGRST202 (function missing) → rpc_missing, one call, nothing sent, no driver text", async () => {
    cloud.finalizeScript = ["pgrst202"];
    const result = await submit();
    expect(result).toMatchObject({ success: false, error: SUBMISSION_NOT_SENT_ERROR });
    expect(cloud.calls.filter((c) => c.fn === "finalize_submission")).toHaveLength(1);
    expect(failureEvents()[0]).toMatchObject({ tags: { reason: "rpc_missing" } });
    expect(result.error).not.toMatch(/PGRST|schema cache|function/i);
    expectNothingLeft();
  });
});

// ============================================================================
// FINALIZE'S ANSWERS
// ============================================================================

describe("BACKLOG-3403 — what finalize says decides", () => {
  /**
   * D5 (plan X5: zero tests saw local status written on a failed finalize).
   * MUTATION: write the local status before/regardless of finalize → red.
   */
  it("D5: refused twice → not sent, removed, and the local status is NEVER written", async () => {
    cloud.finalizeScript = ["refuse_incomplete", "refuse_incomplete"];
    const result = await submit();
    expect(result).toMatchObject({ success: false, error: SUBMISSION_NOT_SENT_ERROR });
    expect(localStatusWrites()).toEqual([]);
    expect(localTx.submission_status).toBe("not_submitted");
    expectNothingLeft();
    expect(failureEvents()[0]).toMatchObject({
      tags: { reason: "finalize_refused" },
      extra: expect.objectContaining({ refusal: expect.objectContaining({ messages_missing: 1 }) }),
    });
    // Flat counts for the attempt row (nested ones would be dropped).
    const ended = cloud.attemptCalls.find((a) => a.p_outcome === "failed")!;
    expect(ended.p_counts).toMatchObject({ messages: 3, attachments: 2, refusal_messages_missing: 1 });
  });

  /**
   * D4: one refusal → the writes run once more → finalize once more.
   * Here a message batch was accepted but never stored (a "phantom"), so the
   * first finalize really is short; the re-run repairs it.
   * MUTATION: no re-run (abandon on the first refusal) → red.
   */
  it("D4: refused once because a batch never landed → re-sent once, finalized on the second call", async () => {
    cloud.script["submission_messages:insert"] = ["phantom"];
    const result = await submit();
    expect(result.success).toBe(true);
    expect(cloud.calls.filter((c) => c.fn === "finalize_submission")).toHaveLength(2);
    expect(subRows()[0].status).toBe("submitted");
    expect(cloud.tables.submission_messages).toHaveLength(3);
  });

  /**
   * D15: a refusal about the CHECKLISTS re-runs the checklist snapshot too.
   * MUTATION: leave the snapshot out of the re-run → refused again → red.
   */
  it("D15: a checklist-only refusal re-runs the snapshot", async () => {
    checklistsForTx = {
      checklists: [{ checklist: { templateId: null, templateName: "Purchase", sortOrder: 0 }, items: [], linksByItemId: {} }],
      requiredDone: 0,
      requiredTotal: 0,
    };
    cloud.snapshotPhantoms = 1;
    const result = await submit();
    expect(result.success).toBe(true);
    expect(cloud.calls.filter((c) => c.fn === "snapshot_submission_checklists")).toHaveLength(2);
    expect(cloud.tables.submission_checklists).toHaveLength(1);
  });

  /**
   * SR condition 2: the id is minted per attempt, so `not_uploading` means
   * OUR finalize committed. MUTATION: route not_uploading to abandon → red.
   */
  it("`not_uploading` is a commit: success, nothing deleted, local status from the row", async () => {
    // The commit happened (status moved on — here the broker already opened it)
    // and its answer was replaced by a second call's not_uploading.
    cloud.finalizeScript = ["lost"];
    cloud.script["transaction_submissions:select"] = [];
    const realRpc = cloud.rpc.bind(cloud);
    let call = 0;
    jest.spyOn(cloud, "rpc").mockImplementation(async (fn: string, args: Row) => {
      if (fn === "finalize_submission") {
        call += 1;
        const sub = subRows()[0];
        sub.status = "under_review";
        return { data: { ok: false, code: "not_uploading" }, error: null };
      }
      return realRpc(fn, args);
    });
    const result = await submit();
    expect(call).toBe(1);
    expect(result.success).toBe(true);
    // Routed as a commit, not through the cleanup: the fence is never even
    // attempted. (Through the cleanup the fence would ALSO find it committed
    // and report success — so success alone cannot tell the two apart.)
    expect(cloud.calls.filter((c) => c.kind === "from" && c.op === "update")).toEqual([]);
    expect(cloud.calls.some((c) => c.kind === "storage.remove")).toBe(false);
    expect(subRows()).toHaveLength(1);
    expect(localTx.submission_status).toBe("under_review");
    expect(failureEvents()).toEqual([]);
  });

  it("`abandoned` (a fence won) is a failure, never a success", async () => {
    jest.spyOn(cloud, "rpc").mockImplementation(async (fn: string, args: Row) => {
      if (fn === "finalize_submission") return { data: { ok: false, code: "abandoned" }, error: null };
      return FakeCloud.prototype.rpc.call(cloud, fn, args);
    });
    const result = await submit();
    expect(result).toMatchObject({ success: false, error: SUBMISSION_NOT_SENT_ERROR });
    expect(localStatusWrites()).toEqual([]);
  });

  /**
   * No answer from finalize, and it DID commit (the answer was lost): the
   * read-back sees a non-uploading status → success.
   */
  it("no answer, but the read-back shows it committed → success, nothing deleted", async () => {
    cloud.finalizeScript = ["network", "network", "network"];
    jest.spyOn(cloud, "rpc").mockImplementation(async (fn: string, args: Row) => {
      if (fn === "finalize_submission") {
        subRows()[0].status = "submitted"; // the server committed; the client never heard
        return { data: null, error: NETWORK };
      }
      return FakeCloud.prototype.rpc.call(cloud, fn, args);
    });
    const result = await submit();
    expect(result.success).toBe(true);
    // The read-back decided: no fence was attempted (the fence would also
    // find the commit, so success alone does not prove the read-back ran).
    expect(cloud.calls.filter((c) => c.kind === "from" && c.op === "update")).toEqual([]);
    expect(cloud.calls.some((c) => c.kind === "storage.remove")).toBe(false);
    expect(localTx.submission_status).toBe("submitted");
  });

  /**
   * SR condition 1, the race (R1): finalize is still running when the client
   * gives up; the read-back still says `uploading`. The fence waits on
   * finalize's lock, finds it committed, and returns 0 rows — so NOTHING may
   * be deleted. MUTATION: skip the fence → deletes issued → red.
   */
  it("R1: a fence that returns 0 rows deletes nothing and reports the commit", async () => {
    cloud.finalizeScript = ["lost", "network", "network"];
    // The fence's UPDATE "waits" for the lingering finalize, which commits first.
    const realFrom = cloud.from.bind(cloud);
    jest.spyOn(cloud, "from").mockImplementation((table: string) => {
      const b = realFrom(table) as Record<string, (...a: unknown[]) => unknown>;
      const realUpdate = b.update;
      b.update = (p: unknown) => {
        if (table === "transaction_submissions" && cloud.pendingFinalize) {
          cloud.pendingFinalize();
          cloud.pendingFinalize = null;
        }
        return realUpdate(p);
      };
      return b as never;
    });

    const result = await submit();

    expect(cloud.calls.filter((c) => c.kind === "storage.remove")).toEqual([]);
    expect(cloud.calls.filter((c) => c.kind === "from" && c.op === "delete" && c.table !== "error_logs")).toEqual([]);
    expect(subRows()).toHaveLength(1);
    expect(subRows()[0].status).toBe("submitted");
    expect(cloud.objects.size).toBe(2);
    expect(result.success).toBe(true);
    expect(localTx.submission_status).toBe("submitted");
  });

  it("no answer AND the read-back fails → unconfirmed: nothing deleted, local status untouched", async () => {
    cloud.finalizeScript = ["network", "network", "network"];
    cloud.script["transaction_submissions:select"] = [];
    const realFrom = cloud.from.bind(cloud);
    let finalizeTried = false;
    jest.spyOn(cloud, "rpc").mockImplementation(async (fn: string, args: Row) => {
      if (fn === "finalize_submission") finalizeTried = true;
      return FakeCloud.prototype.rpc.call(cloud, fn, args);
    });
    jest.spyOn(cloud, "from").mockImplementation((table: string) => {
      if (finalizeTried && table === "transaction_submissions") {
        cloud.script["transaction_submissions:select"] = ["network"];
      }
      return realFrom(table) as never;
    });
    const result = await submit();
    expect(result).toMatchObject({ success: false, unconfirmed: true, error: SUBMISSION_UNCONFIRMED_ERROR });
    expect(cloud.calls.some((c) => c.kind === "storage.remove")).toBe(false);
    expect(subRows()).toHaveLength(1);
    expect(localStatusWrites()).toEqual([]);
    expect(cloud.attemptCalls.some((a) => a.p_outcome === "unconfirmed")).toBe(true);
  });
});

// ============================================================================
// SR CONDITIONS (pm_comments 8fa92bef)
// ============================================================================

describe("SR C1 — an attempt row exists only for an attempt that wrote something", () => {
  /** MUTATIONS: in_progress before the guard → red; final record gated on orgId only → red. */
  it("a refusal by the existing-submission guard records NO attempt row", async () => {
    cloud.tables.transaction_submissions.push({ id: "sub-old", organization_id: ORG, submitted_by: USER, local_transaction_id: TX, status: "submitted", version: 1 });
    const result = await submit();
    expect(result.success).toBe(false);
    expect(cloud.attemptCalls).toEqual([]);
  });

  it("an unconfirmed pre-flight list records NO attempt row", async () => {
    setPreflightStatForTests(async () => null);
    const result = await submit();
    expect(result).toMatchObject({ success: false, preflightChanged: true });
    expect(cloud.attemptCalls).toEqual([]);
  });

  /** MUTATION: send in_progress without awaiting (fire-and-forget) → the order changes → red. */
  it("the in_progress row is written, awaited, immediately before the parent write", async () => {
    let releaseAttempt: () => void = () => undefined;
    const realRpc = cloud.rpc.bind(cloud);
    jest.spyOn(cloud, "rpc").mockImplementation(async (fn: string, args: Row) => {
      if (fn === "record_submission_attempt" && args.p_outcome === "in_progress") {
        // A slow answer: the flow must wait for it before writing anything.
        await new Promise<void>((r) => { releaseAttempt = r; setTimeout(r, 20); });
        cloud.calls.push({ kind: "attempt-landed" });
      }
      return realRpc(fn, args);
    });
    const result = await submit();
    void releaseAttempt;
    expect(result.success).toBe(true);
    const seq = cloud.calls
      .filter((c) => c.kind === "attempt-landed" || (c.kind === "from" && c.op === "insert"))
      .map((c) => (c.kind === "attempt-landed" ? "in_progress" : c.table));
    expect(seq[0]).toBe("in_progress");
    expect(seq[1]).toBe("transaction_submissions");
  });
});

describe("SR C2 — a cancel accepted before finalize is honoured", () => {
  /** MUTATION SRX1: drop the cancel check right before the first finalize → red. */
  it("cancel during the checklist snapshot → no finalize call, cancelled, cleaned up", async () => {
    const realRpc = cloud.rpc.bind(cloud);
    jest.spyOn(cloud, "rpc").mockImplementation(async (fn: string, args: Row) => {
      if (fn === "snapshot_submission_checklists") submissionService.cancelSubmission(TX);
      return realRpc(fn, args);
    });
    const result = await submit();
    expect(result).toMatchObject({ success: false, cancelled: true });
    expect(cloud.calls.some((c) => c.fn === "finalize_submission")).toBe(false);
    expectNothingLeft();
  });

  /** MUTATION: remove the new check before the second finalize → red. */
  it("cancel during the re-run's last upload → no second finalize, cancelled", async () => {
    cloud.script["submission_messages:insert"] = ["phantom"]; // first finalize refuses
    let uploads = 0;
    (supabaseStorageService.uploadAttachmentWithRetry as jest.Mock).mockImplementation(
      async (org: string, sub: string, id: string, localPath: string, filename: string) => {
        uploads += 1;
        const storagePath = buildAttachmentStoragePath(org, sub, id, filename);
        cloud.objects.add(storagePath);
        if (uploads === 4) expect(submissionService.cancelSubmission(TX)).toEqual({ cancelled: true });
        return { localId: localPath, storagePath, success: true };
      }
    );
    const result = await submit();
    expect(uploads).toBe(4);
    expect(cloud.calls.filter((c) => c.fn === "finalize_submission")).toHaveLength(1);
    expect(result).toMatchObject({ success: false, cancelled: true });
    expectNothingLeft();
  });
});

describe("SR C3 — a success found by the cleanup keeps what was left out", () => {
  /** MUTATION SRX4-style: return notIncluded [] in the rescued branch → red. */
  it("R1 with one confirmed exclusion: success still lists it and sends the 3681 warning", async () => {
    setPreflightStatForTests(async (p: string) => (p.endsWith("Inspection.pdf") ? { size: 50 * 1024 * 1024 + 1 } : { size: 2048 }));
    cloud.finalizeScript = ["lost", "network", "network"];
    const realFrom = cloud.from.bind(cloud);
    jest.spyOn(cloud, "from").mockImplementation((table: string) => {
      const b = realFrom(table) as Record<string, (...a: unknown[]) => unknown>;
      const realUpdate = b.update;
      b.update = (p: unknown) => {
        if (table === "transaction_submissions" && cloud.pendingFinalize) {
          cloud.pendingFinalize();
          cloud.pendingFinalize = null;
        }
        return realUpdate(p);
      };
      return b as never;
    });
    const result = await submissionService.submitTransaction(TX, undefined, { acceptedExclusionKeys: ["att:att-pdf"] });
    expect(result.success).toBe(true);
    expect(result.notIncluded.map((i) => i.key)).toEqual(["att:att-pdf"]);
    expect(result.flaggedWithoutAttachments).toBe(1);
    expect(captured.filter((e) => e.message === "Submission sent with exclusions")).toHaveLength(1);
    expect(cloud.calls.filter((c) => c.kind === "storage.remove")).toEqual([]);
  });
});

describe("SR C4 — a file that could not be removed stops the cleanup", () => {
  /** MUTATION: remove the early return in abandonSubmission → rows deleted over the file → red. */
  it("storage remove fails 3 times → the fenced row and its attachment rows stay, naming the file", async () => {
    cloud.finalizeScript = [{ code: "42501", message: "permission denied" }];
    cloud.removeFailures = 3;
    const result = await submit();
    expect(result.success).toBe(false);
    expect(subRows()).toHaveLength(1);
    expect(subRows()[0].abandoned_at).toBeTruthy();
    expect(cloud.tables.submission_attachments).toHaveLength(2);
    expect(cloud.objects.size).toBe(2);
    expect(failureEvents()[0]).toMatchObject({ extra: expect.objectContaining({ cleanup_complete: false }) });
  });
});

describe("SR S5 — the read-back counts any non-uploading status as committed", () => {
  it.each(["resubmitted", "under_review"])("no answer, read-back shows %s → success, no fence", async (status) => {
    cloud.finalizeScript = ["network", "network", "network"];
    jest.spyOn(cloud, "rpc").mockImplementation(async (fn: string, args: Row) => {
      if (fn === "finalize_submission") {
        subRows()[0].status = status;
        return { data: null, error: NETWORK };
      }
      return FakeCloud.prototype.rpc.call(cloud, fn, args);
    });
    const result = await submit();
    expect(result.success).toBe(true);
    expect(cloud.calls.filter((c) => c.kind === "from" && c.op === "update")).toEqual([]);
    expect(localTx.submission_status).toBe(status);
  });
});

// ============================================================================
// CANCEL (BACKLOG-3398)
// ============================================================================

describe("BACKLOG-3398 — Cancel really cancels", () => {
  /**
   * D8. Cancel during the uploads: no finalize, everything removed, no
   * Sentry event (a user action), the attempt recorded as cancelled.
   * MUTATION: ignore the abort signal → it finalizes → red.
   */
  it("D8: cancel before the final step → nothing sent, everything removed, no Sentry", async () => {
    (supabaseStorageService.uploadAttachmentWithRetry as jest.Mock).mockImplementationOnce(
      async (org: string, sub: string, id: string, localPath: string, filename: string) => {
        const storagePath = buildAttachmentStoragePath(org, sub, id, filename);
        cloud.objects.add(storagePath);
        // The agent presses Cancel while the first file uploads.
        expect(submissionService.cancelSubmission(TX)).toEqual({ cancelled: true });
        return { localId: localPath, storagePath, success: true };
      }
    );
    const result = await submit();
    expect(result).toMatchObject({ success: false, cancelled: true, error: SUBMISSION_CANCELLED_MESSAGE });
    expect(cloud.calls.some((c) => c.fn === "finalize_submission")).toBe(false);
    expectNothingLeft();
    expect(captured).toEqual([]);
    expect(localStatusWrites()).toEqual([]);
    expect(cloud.attemptCalls.map((a) => a.p_outcome)).toEqual(["in_progress", "cancelled"]);
  });

  it("D8b: once the final step began, Cancel is refused and the submission completes", async () => {
    let answer: unknown;
    jest.spyOn(cloud, "rpc").mockImplementation(async (fn: string, args: Row) => {
      if (fn === "finalize_submission") answer = submissionService.cancelSubmission(TX);
      return FakeCloud.prototype.rpc.call(cloud, fn, args);
    });
    const result = await submit();
    expect(answer).toEqual({ cancelled: false, reason: "finalizing" });
    expect(result.success).toBe(true);
  });

  it("Cancel with nothing running is a no-op", () => {
    expect(submissionService.cancelSubmission(TX)).toEqual({ cancelled: false, reason: "not_running" });
  });
});

// ============================================================================
// PRE-FLIGHT + 3681
// ============================================================================

describe("BACKLOG-3403 / 3681 — files that can never be sent", () => {
  beforeEach(() => {
    setPreflightStatForTests(async (p: string) =>
      p.endsWith("Inspection.pdf") ? { size: 50 * 1024 * 1024 + 1 } : { size: 2048 }
    );
  });

  it("listed before sending; an unconfirmed list sends nothing", async () => {
    const pf = await submissionService.preflightSubmission(TX);
    expect(pf.notIncluded.map((i) => [i.key, i.reason, i.filename, i.label])).toEqual([
      ["att:att-pdf", "file_too_large", "Inspection.pdf", "Inspection report"],
    ]);
    const result = await submit();
    expect(result).toMatchObject({ success: false, preflightChanged: true });
    expect(cloud.calls.filter((c) => c.kind === "from" && c.op !== "select" && c.table !== "error_logs")).toEqual([]);
  });

  /**
   * D10: confirmed → the rest is sent; the file is recorded for the broker in
   * submission_metadata.excluded_files; the agent gets one line per message;
   * Sentry gets ONE warning with reason codes and cloud message ids only.
   */
  it("D10: confirmed → sent without it, recorded for the broker, listed for the agent, one Sentry warning without names", async () => {
    const result = await submissionService.submitTransaction(TX, undefined, { acceptedExclusionKeys: ["att:att-pdf"] });
    expect(result.success).toBe(true);
    expect(result.attachmentsCount).toBe(1);
    expect(result.notIncluded.map((i) => i.reason)).toEqual(["file_too_large"]);
    const meta = subRows()[0].submission_metadata as { excluded_files: Row[] };
    const emailCloudId = cloud.tables.submission_messages.find((m) => m.local_message_id === "em-1")!.id;
    expect(meta.excluded_files).toEqual([
      { filename: "Inspection.pdf", kind: "email", message_id: emailCloudId, sent_at: "2026-09-22T10:00:00.000Z", source_label: "Inspection report", reason: "file_too_large" },
    ]);
    const warnings = captured.filter((e) => e.message === "Submission sent with exclusions");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      level: "warning",
      extra: expect.objectContaining({
        not_included_total: 1,
        not_included_by_reason: { file_too_large: 1 },
        not_included: [{ kind: "email", reason: "file_too_large", submission_message_id: emailCloudId }],
      }),
    });
    expectNoPii();
  });

  it("a text whose photo is not on this computer is named by its other party", async () => {
    (databaseService.getTransactionAttachments as jest.Mock).mockReturnValue([ATTACHMENTS[1]]);
    setPreflightStatForTests(async () => ({ size: 2048 }));
    const pf = await submissionService.preflightSubmission(TX);
    expect(pf.notIncluded).toEqual([
      expect.objectContaining({ key: "msg:msg-1", kind: "text", label: "Jane Fixture", reason: "text_attachment_not_on_this_computer", filename: null }),
    ]);
  });
});

// ============================================================================
// BACKLOG-3715 — the in_progress attempt row carries what it is about to send
// ============================================================================

describe("BACKLOG-3715 — attempt counts", () => {
  beforeEach(() => {
    setPreflightStatForTests(async (p: string) =>
      p.endsWith("Inspection.pdf") ? { size: 50 * 1024 * 1024 + 1 } : { size: 2048 }
    );
  });

  /**
   * MUTATION: send `counts: {}` on the in_progress row (pre-3715) → red.
   * The keys must be flat snake_case whole numbers, or the server drops them.
   */
  it("the in_progress row carries messages, attachments and not_included", async () => {
    const result = await submissionService.submitTransaction(TX, undefined, { acceptedExclusionKeys: ["att:att-pdf"] });
    expect(result.success).toBe(true);
    const started = cloud.attemptCalls.filter((a) => a.p_outcome === "in_progress");
    expect(started).toHaveLength(1);
    expect(started[0].p_counts).toEqual({ messages: 3, attachments: 1, not_included: 1 });
  });

  /**
   * The server merges `counts || new`, so a later update replaces any key it
   * re-sends. A failure's final update must not re-send these keys with other
   * values (e.g. a 0 from a manifest that was never built).
   */
  it("a failure's final update keeps the started counts", async () => {
    cloud.script["submission_messages:insert"] = ["network", "network", "network"];
    const result = await submissionService.submitTransaction(TX, undefined, { acceptedExclusionKeys: ["att:att-pdf"] });
    expect(result.success).toBe(false);
    const [started, ended] = cloud.attemptCalls;
    expect(started.p_outcome).toBe("in_progress");
    expect(ended.p_outcome).toBe("failed");
    const merged = { ...(started.p_counts as Row), ...(ended.p_counts as Row) };
    expect(merged).toMatchObject({ messages: 3, attachments: 1, not_included: 1 });
  });
});
