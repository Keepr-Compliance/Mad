/**
 * @jest-environment node
 *
 * BACKLOG-3477 (PR B) — SUBMIT COPIES EVERY CHECKLIST ONTO THE SUBMISSION.
 *
 * Real driver, real schema for the LOCAL side: checklists are created with
 * `selectChecklistTemplate` / `addChecklistLink`, and the texts, emails and
 * attachments that go up are gathered by the real `submissionDbService`
 * queries. Nothing the snapshot reads is hand-written.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIXTURE PROVENANCE — the CLOUD side is transcribed, not invented
 * ─────────────────────────────────────────────────────────────────────────────
 * `rpc("snapshot_submission_checklists")` below follows the function body in
 * supabase/migrations/20260925073000_backlog_3477_submission_checklist_review.sql
 * §6 (applied to production as ledger 20260925222704): one call is one
 * statement, so any refusal leaves zero rows; `template_id` is cast `::uuid`;
 * attachment links match `submission_attachments.local_attachment_id` (every
 * match), email links match `submission_messages.local_message_id` with
 * channel 'email'; a local id with no match is dropped and a link with no
 * member is not written.
 *
 * The function is SECURITY INVOKER, so the copy tables' INSERT policies apply.
 * Read from production `pg_policies` on 2026-09-25:
 *
 *   submission_checklists_insert  WITH CHECK
 *     added_at_review_by IS NULL AND added_at_review_at IS NULL AND
 *     EXISTS (ts: ts.id = submission_id AND ts.submitted_by = auth.uid()
 *             AND ts.status = 'uploading'
 *             AND COALESCE((check_feature_access(ts.organization_id,
 *                   'transaction_checklists') ->> 'allowed')::boolean, false))
 *   submission_checklist_items_insert  WITH CHECK
 *     reviewer_checked = false AND reviewer_checked_by IS NULL AND
 *     reviewer_checked_at IS NULL AND
 *     EXISTS (ts: submitted_by = auth.uid() AND status = 'uploading')
 *   submission_checklist_links_insert  WITH CHECK
 *     EXISTS (ts: submitted_by = auth.uid() AND status = 'uploading')
 *   submission_checklist_link_members_insert  WITH CHECK
 *     EXISTS (ts: submitted_by = auth.uid() AND status = 'uploading')
 *     AND the attachment / email belongs to the same submission
 *
 * The upload result's `localId` is the local FILE PATH
 * (`supabaseStorageService.uploadAttachmentWithRetry` returns
 * `localId: localPath`), and local email attachments are content-addressed
 * (`emailAttachmentService` names the file by content hash), so two local
 * attachment rows with the same bytes share one path. The fixture has such a
 * pair.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WRONG IMPLEMENTATIONS THIS SUITE EXISTS TO CATCH (controls on BACKLOG-3477)
 * ─────────────────────────────────────────────────────────────────────────────
 *   the call placed after finalize   -> every insert refused, swallowed as
 *                                       non-fatal; the submission looks fine
 *   local_attachment_id never written, or written from the wrong key
 *                                    -> every attachment link silently dropped
 *   the local id found by file path  -> the second of two same-bytes files
 *                                       takes the first one's id
 *   one checklist only               -> the rest never reach the broker
 *   a refusal that fails the submit  -> a plan without checklists cannot submit
 *
 * RUNNER (real sqlite -> Electron ABI):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 electron/services/__tests__/submissionChecklistSnapshot-3477.test.ts
 */
import * as nodePath from "path";
import * as fs from "fs";
import { randomUUID } from "crypto";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;

jest.mock("../db/core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
  ensureDb: () => db,
  getRawDatabase: () => db,
}));
jest.mock("../supabaseService");
jest.mock("../supabaseStorageService");
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
// BACKLOG-3595: the resubmit pre-pull tells an open window when it adds a checklist.
jest.mock("../../windowRegistry", () => ({ sendToMainWindow: jest.fn(() => true) }));
jest.mock("electron", () => ({
  app: { getVersion: jest.fn().mockReturnValue("2.38.1") },
  net: { isOnline: () => false },
}));

import { submissionService } from "../submissionService";
import supabaseService from "../supabaseService";
import supabaseStorageService from "../supabaseStorageService";
import databaseService from "../databaseService";
import logService from "../logService";
import {
  addChecklistLink,
  selectChecklistTemplate,
  setChecklistLinkIncludeOutsideDates,
} from "../db/checklistDbService";
import {
  SNAPSHOT_RETRY,
  SNAPSHOT_RPC,
  buildChecklistSnapshotPayload,
  type SnapshotChecklistPayload,
} from "../submissionChecklistSnapshot";
import { CHECKLISTS_NOT_SENT_ERROR } from "../submissionService";
import { buildAttachmentStoragePath } from "../submissionAttachmentFiles";
import { setPreflightStatForTests } from "../submissionPreflight";
import { setStageRetryDelaysForTests } from "../submissionStageRetry";
import { retryOwedReviewChecklistPull } from "../submissionChecklistPull";
import { getOwedReviewChecklistPullsFor, markReviewChecklistPullOwed } from "../db/submissionDbService";
import * as Sentry from "@sentry/electron/main";
import { getChecklistsForTransaction } from "../db/checklistDbService";
import * as checklistDbModule from "../db/checklistDbService";
import { sendToMainWindow } from "../../windowRegistry";

const submissionDb = jest.requireActual("../db/submissionDbService") as typeof import("../db/submissionDbService");

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const ORG = "org-3477";
const USER = "user-3477";
const TX = "txn-3477";
/**
 * Live `checklist_templates.id` is uuid and the function casts `::uuid`, so
 * the ids must be uuid-shaped. Generated per run, never a stored value.
 */
const TPL_PURCHASE = randomUUID();
const TPL_DISCLOSURE = randomUUID();

type Row = Record<string, unknown>;
type PgError = { code: string; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// FAKE SUPABASE — the submission tables plus the four copy tables and the RPC
// ============================================================================
class FakeSupabase {
  tables: Record<string, Row[]> = {
    transaction_submissions: [],
    submission_messages: [],
    submission_attachments: [],
    organization_members: [{ id: "m-1", user_id: USER, organization_id: ORG, created_at: "2026-01-01T00:00:00Z" }],
    error_logs: [],
    submission_checklists: [],
    submission_checklist_items: [],
    submission_checklist_links: [],
    submission_checklist_link_members: [],
  };
  /** `check_feature_access(org, 'transaction_checklists') ->> 'allowed'`. */
  checklistsFeatureAllowed = true;
  /**
   * SNAPSHOT_RPC calls only. Every call-count assert in this file counts
   * snapshot calls, and `rpcScript` is indexed by this array's length, so any
   * other RPC the submit path makes (BACKLOG-3519's split resolution, for one)
   * goes to `otherRpcCalls` instead and cannot shift either.
   */
  rpcCalls: { fn: string; args: Row; parentStatusAtCall: unknown }[] = [];
  /** Every non-SNAPSHOT_RPC call, in order. */
  otherRpcCalls: { fn: string; args: Row }[] = [];
  /**
   * BACKLOG-3600: what the Nth snapshot call does, in order; past the end of
   * the script every call runs normally. Shapes, from supabase-js:
   *   "network"  a fetch failure: `{ code: "", message: "TypeError: fetch failed" }`
   *              (transcribed from @supabase/postgrest-js dist/index.cjs:328-367:
   *              the fetch catch returns `code: ""`, `message: "<name>: <message>"`)
   *   "lost"     the call COMMITS, then the response is lost as a fetch failure
   *   "hang"     never settles (bounded only by the caller's timeout)
   *   PgError    returned as the error, nothing written
   */
  rpcScript: Array<"network" | "lost" | "hang" | PgError | undefined> = [];
  /** Insert calls per table (one `.insert(...)` = one call, however many rows). */
  insertCalls: Record<string, number> = {};
  /** BACKLOG-3599: tables whose SELECTs return an error (a failed pull). */
  failReadsOf = new Set<string>();
  /** BACKLOG-3599: `uploading` submissions present at each checklist-header read. */
  uploadingAtChecklistRead: number[] = [];
  private seq = 0;
  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  from(tableName: string) {
    const all = () => {
      const t = this.tables[tableName];
      if (!t) throw new Error(`FakeSupabase: unknown table ${tableName}`);
      return t;
    };
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    /** BACKLOG-3403: upsert(…, { ignoreDuplicates }) = ON CONFLICT (id) DO NOTHING. */
    let ignoreDuplicateIds = false;
    const matched = () => all().filter((r) => filters.every((f) => f(r)));

    const run = (): { data: unknown; error: PgError | null } => {
      if (mode === "select" && this.failReadsOf.has(tableName)) {
        return { data: null, error: { code: "", message: "TypeError: fetch failed" } };
      }
      if (mode === "select" && tableName === "submission_checklists") {
        this.uploadingAtChecklistRead.push(
          this.tables.transaction_submissions.filter((t) => t.status === "uploading").length,
        );
      }
      if (mode === "select") {
        const out = matched();
        return { data: limitN === null ? out : out.slice(0, limitN), error: null };
      }
      if (mode === "update") {
        // RETURNING: the rows the WHERE matched, as updated (BACKLOG-3403's
        // fence filters on the column it sets).
        const hit = matched();
        for (const r of hit) Object.assign(r, payload as Row);
        return { data: hit, error: null };
      }
      if (mode === "delete") {
        const gone = new Set(matched());
        this.tables[tableName] = all().filter((r) => !gone.has(r));
        return { data: null, error: null };
      }
      const incoming = Array.isArray(payload) ? payload : [payload as Row];
      this.insertCalls[tableName] = (this.insertCalls[tableName] ?? 0) + 1;
      for (const rec of incoming) {
        if (ignoreDuplicateIds && rec.id !== undefined && all().some((r) => r.id === rec.id)) continue;
        all().push({ id: rec.id ?? this.id(tableName), ...rec });
      }
      return { data: incoming, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (p: Row | Row[]) => ((mode = "insert"), (payload = p), builder),
      upsert: (p: Row | Row[], opts?: { ignoreDuplicates?: boolean }) => (
        (mode = "insert"), (payload = p), (ignoreDuplicateIds = opts?.ignoreDuplicates === true), builder
      ),
      update: (p: Row) => ((mode = "update"), (payload = p), builder),
      delete: () => ((mode = "delete"), builder),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), builder),
      // BACKLOG-3607 (SR R-3): `.neq(col, v)`, as PostgREST: `col <> v`, so a
      // NULL column does not match either.
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== null && r[c] !== undefined && r[c] !== v), builder),
      not: (c: string, op: string, v: unknown) => {
        if (op !== "is" || v !== null) throw new Error("FakeSupabase: unsupported not()");
        filters.push((r) => r[c] !== null && r[c] !== undefined);
        return builder;
      },
      // BACKLOG-3607: `.is(col, null)`.
      is: (c: string, v: unknown) => {
        if (v !== null) throw new Error("FakeSupabase: unsupported is()");
        filters.push((r) => r[c] === null || r[c] === undefined);
        return builder;
      },
      order: () => builder,
      limit: (n: number) => ((limitN = n), builder),
      maybeSingle: () => {
        const rows = run().data as Row[];
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single: () => {
        const rows = run().data as Row[];
        return Promise.resolve(
          rows.length === 1
            ? { data: rows[0], error: null }
            : { data: null, error: { code: "PGRST116", message: "no rows" } },
        );
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };
    return builder;
  }

  /** The copy tables' INSERT policies, transcribed above. */
  private submitterMayInsert(submissionId: unknown, header: boolean): boolean {
    const ts = this.tables.transaction_submissions.find((s) => s.id === submissionId);
    if (!ts || ts.submitted_by !== USER || ts.status !== "uploading") return false;
    return header ? this.checklistsFeatureAllowed : true;
  }

  /** BACKLOG-3403: storage objects by path; abandon removes by exact path. */
  objects = new Set<string>();
  storage = {
    from: (_bucket: string) => ({
      remove: async (paths: string[]) => {
        const gone = paths.filter((p) => this.objects.delete(p));
        return { data: gone.map((name) => ({ name })), error: null };
      },
    }),
  };

  /**
   * BACKLOG-3403: finalize_submission's success and state branches, transcribed
   * from 20261004192647_backlog_3403_finalize_submission.sql:237-302 (the
   * manifest check itself is covered by submissionAtomic-3403 and the SQL
   * suite). record_submission_attempt answers as :208.
   */
  private submissionRpc(fn: string, args: Row): Promise<{ data: unknown; error: PgError | null }> | null {
    if (fn === "record_submission_attempt") {
      return Promise.resolve({ data: { ok: true, outcome: args.p_outcome, unchanged: false }, error: null });
    }
    if (fn !== "finalize_submission") return null;
    const sub = this.tables.transaction_submissions.find((s) => s.id === args.p_submission_id);
    if (!sub) return Promise.resolve({ data: { ok: false, code: "not_found" }, error: null });
    if (sub.submitted_by !== USER) return Promise.resolve({ data: { ok: false, code: "not_owner" }, error: null });
    const target = sub.parent_submission_id ? "resubmitted" : "submitted";
    if (sub.status === target) return Promise.resolve({ data: { ok: true, already_final: true, status: target }, error: null });
    if (sub.status !== "uploading") return Promise.resolve({ data: { ok: false, code: "not_uploading" }, error: null });
    if (sub.abandoned_at) return Promise.resolve({ data: { ok: false, code: "abandoned" }, error: null });
    sub.status = target;
    return Promise.resolve({ data: { ok: true, already_final: false, status: target }, error: null });
  }

  rpc(fn: string, args: Row): Promise<{ data: unknown; error: PgError | null }> {
    if (fn !== SNAPSHOT_RPC) {
      this.otherRpcCalls.push({ fn, args });
      const answered = this.submissionRpc(fn, args);
      if (answered) return answered;
      return this.runSnapshot(args, fn);
    }
    const parent = this.tables.transaction_submissions.find((s) => s.id === args.p_submission_id);
    this.rpcCalls.push({ fn, args, parentStatusAtCall: parent?.status });
    const scripted = this.rpcScript[this.rpcCalls.length - 1];
    const networkError = { data: null, error: { code: "", message: "TypeError: fetch failed" } };
    if (scripted === "network") return Promise.resolve(networkError);
    if (scripted === "hang") return new Promise(() => undefined);
    if (scripted === "lost") return this.runSnapshot(args).then(() => networkError);
    if (scripted) return Promise.resolve({ data: null, error: scripted });
    return this.runSnapshot(args, fn);
  }

  private runSnapshot(args: Row, fn: string = SNAPSHOT_RPC): Promise<{ data: unknown; error: PgError | null }> {
    if (fn !== SNAPSHOT_RPC) {
      return Promise.resolve({ data: null, error: { code: "42883", message: `function ${fn} does not exist` } });
    }
    // One statement = one transaction: stage every row, commit only at the end.
    const staged: Record<string, Row[]> = {
      submission_checklists: [],
      submission_checklist_items: [],
      submission_checklist_links: [],
      submission_checklist_link_members: [],
    };
    const refuse = (table: string): { data: null; error: PgError } => ({
      data: null,
      error: { code: "42501", message: `new row violates row-level security policy for table "${table}"` },
    });
    const sid = args.p_submission_id;
    const list = args.p_checklists;
    if (!sid || !Array.isArray(list)) {
      return Promise.resolve({ data: null, error: { code: "22023", message: "invalid_payload" } });
    }
    const n = { checklists: 0, items: 0, links: 0, members: 0, dropped_members: 0, dropped_links: 0 };
    for (const c of list as Row[]) {
      const templateId = c.template_id == null || c.template_id === "" ? null : String(c.template_id);
      if (templateId !== null && !UUID_RE.test(templateId)) {
        return Promise.resolve({
          data: null,
          error: { code: "22P02", message: `invalid input syntax for type uuid: "${templateId}"` },
        });
      }
      if (!this.submitterMayInsert(sid, true)) return Promise.resolve(refuse("submission_checklists"));
      // supabase/migrations/20260925073000_backlog_3477_submission_checklist_review.sql:101-103
      //   CREATE UNIQUE INDEX IF NOT EXISTS submission_checklists_submission_template_key
      //     ON public.submission_checklists (submission_id, template_id) WHERE template_id IS NOT NULL;
      const clash = [...this.tables.submission_checklists, ...staged.submission_checklists].some(
        (h) => templateId !== null && h.submission_id === sid && h.template_id === templateId,
      );
      if (clash) {
        return Promise.resolve({
          data: null,
          error: {
            code: "23505",
            message: 'duplicate key value violates unique constraint "submission_checklists_submission_template_key"',
          },
        });
      }
      const headerId = this.id("scl");
      staged.submission_checklists.push({
        id: headerId,
        submission_id: sid,
        template_id: templateId,
        template_name: c.template_name,
        sort_order: c.sort_order ?? 0,
        added_at_review_by: null,
        added_at_review_at: null,
        removed_at_review_by: null,
        removed_at_review_at: null,
      });
      n.checklists += 1;
      for (const it of (c.items as Row[]) ?? []) {
        if (!this.submitterMayInsert(sid, false)) return Promise.resolve(refuse("submission_checklist_items"));
        // supabase/migrations/20260928120000_backlog_3596_broker_checklist_ticks.sql:96
        //   submission_checklist_items_submission_local_item_key
        //     ON (submission_id, local_item_id) WHERE local_item_id IS NOT NULL
        const localItemId = it.local_item_id == null || it.local_item_id === "" ? null : String(it.local_item_id);
        const itemClash =
          localItemId !== null &&
          [...this.tables.submission_checklist_items, ...staged.submission_checklist_items].some(
            (x) => x.submission_id === sid && x.local_item_id === localItemId,
          );
        if (itemClash) {
          return Promise.resolve({
            data: null,
            error: {
              code: "23505",
              message: 'duplicate key value violates unique constraint "submission_checklist_items_submission_local_item_key"',
            },
          });
        }
        const itemId = this.id("sci");
        staged.submission_checklist_items.push({
          id: itemId,
          submission_id: sid,
          submission_checklist_id: headerId,
          title: it.title,
          // BACKLOG-3596 migration 20260928120000 §4: NULLIF(it ->> 'local_item_id', '').
          // A payload without the key (an older desktop) stores NULL.
          local_item_id: localItemId,
          description: it.description ?? null,
          is_required: it.is_required ?? false,
          expected_document_type: it.expected_document_type ?? null,
          is_checked: it.is_checked ?? false,
          note: it.note ?? null,
          sort_order: it.sort_order ?? 0,
          reviewer_checked: false,
          reviewer_checked_by: null,
          reviewer_checked_at: null,
        });
        n.items += 1;
        for (const lk of (it.links as Row[]) ?? []) {
          const kind = lk.kind;
          if (kind !== "attachment" && kind !== "email") {
            return Promise.resolve({ data: null, error: { code: "22023", message: "invalid_payload" } });
          }
          const asked = Array.from(new Set((lk.local_ids as string[]) ?? []));
          const targets =
            kind === "attachment"
              ? this.tables.submission_attachments.filter(
                  (a) => a.submission_id === sid && asked.includes(a.local_attachment_id as string),
                )
              : this.tables.submission_messages.filter(
                  (m) => m.submission_id === sid && m.channel === "email" && asked.includes(m.local_message_id as string),
                );
          const hitIds = new Set(
            targets.map((t) => (kind === "attachment" ? t.local_attachment_id : t.local_message_id)),
          );
          n.dropped_members += asked.length - hitIds.size;
          if (targets.length === 0) {
            n.dropped_links += 1;
            continue;
          }
          if (!this.submitterMayInsert(sid, false)) return Promise.resolve(refuse("submission_checklist_links"));
          const linkId = this.id("slk");
          staged.submission_checklist_links.push({
            id: linkId,
            submission_id: sid,
            submission_checklist_item_id: itemId,
            kind,
            label: lk.label,
            sort_order: lk.sort_order ?? 0,
          });
          n.links += 1;
          for (const t of targets) {
            if (!this.submitterMayInsert(sid, false)) {
              return Promise.resolve(refuse("submission_checklist_link_members"));
            }
            staged.submission_checklist_link_members.push({
              id: this.id("slm"),
              submission_id: sid,
              link_id: linkId,
              kind,
              submission_attachment_id: kind === "attachment" ? t.id : null,
              submission_message_id: kind === "email" ? t.id : null,
            });
          }
          n.members += targets.length;
        }
      }
    }
    for (const [t, rows] of Object.entries(staged)) this.tables[t].push(...rows);
    return Promise.resolve({ data: n, error: null });
  }
}

let fake: FakeSupabase;

// ============================================================================
// LOCAL SEED — produced by the real schema and the real checklist service
// ============================================================================
const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));

function seedLocal(): void {
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'a@example.test', 'google', 'oa-a')`, USER);
  run(`INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '14 Harbor View Rd')`, TX, USER);
  const email = (id: string, subject: string, sentAt: string, hasAttachments: number) =>
    run(
      `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, sent_at, has_attachments)
       VALUES (?, ?, ?, 'gmail', 'acct', ?, 'l@example.com', 'a@example.test', ?, ?)`,
      id, USER, `ext-${id}`, subject, sentAt, hasAttachments,
    );
  email("e-offer", "Offer for 14 Harbor View Rd", "2026-03-01T10:00:00Z", 1);
  email("e-fwd", "Fwd: signed offer", "2026-03-02T10:00:00Z", 1);
  email("e-inspection", "Inspection booked", "2026-03-03T10:00:00Z", 0);
  for (const [cid, eid] of [["c-1", "e-offer"], ["c-2", "e-fwd"], ["c-3", "e-inspection"]]) {
    run(
      `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source) VALUES (?, ?, ?, ?, 'manual')`,
      cid, USER, TX, eid,
    );
  }
  // Same bytes attached to two emails -> one content-addressed file, two rows.
  const SAME_FILE = "/attachments/3f9a0c.pdf";
  run(
    `INSERT INTO attachments (id, email_id, filename, mime_type, storage_path, created_at) VALUES
       ('att-offer', 'e-offer', 'signed-offer.pdf', 'application/pdf', ?, '2026-03-01T10:00:00Z'),
       ('att-fwd',   'e-fwd',   'signed-offer.pdf', 'application/pdf', ?, '2026-03-02T10:00:00Z'),
       ('att-nobytes', 'e-offer', 'disclosure.pdf', 'application/pdf', NULL, '2026-03-01T10:00:01Z')`,
    SAME_FILE, SAME_FILE,
  );
}

async function seedChecklists(): Promise<void> {
  const a = await selectChecklistTemplate({
    transactionId: TX,
    templateId: TPL_PURCHASE,
    templateName: "Residential Purchase",
    items: [
      { title: "Signed purchase agreement", isRequired: true, expectedDocumentType: "contract", sortOrder: 0 },
      { title: "Earnest money receipt", isRequired: true, sortOrder: 1 },
      { title: "Inspection scheduled", isRequired: false, description: "Any inspector", sortOrder: 2 },
    ],
  });
  const b = await selectChecklistTemplate({
    transactionId: TX,
    templateId: TPL_DISCLOSURE,
    templateName: "Seller Disclosures",
    items: [{ title: "Lead paint disclosure", isRequired: true, sortOrder: 0 }],
  });
  if (a.status !== "added" || b.status !== "added") throw new Error("seed: template not added");
  const items = db
    .prepare(`SELECT id, title FROM transaction_checklist_items`)
    .all() as { id: string; title: string }[];
  const item = (title: string) => items.find((i) => i.title === title)!.id;

  run(`UPDATE transaction_checklist_items SET is_checked = 1, checked_at = '2026-03-04T09:00:00Z', note = 'Both copies' WHERE id = ?`, item("Signed purchase agreement"));
  for (const [itemId, kind, targetIds] of [
    [item("Signed purchase agreement"), "attachment", ["att-offer"]],
    [item("Earnest money receipt"), "attachment", ["att-fwd"]],
    [item("Inspection scheduled"), "email", ["e-inspection"]],
    [item("Lead paint disclosure"), "attachment", ["att-nobytes"]],
  ] as const) {
    const r = await addChecklistLink({ itemId, kind, targetIds: [...targetIds] });
    if (r.status !== "added") throw new Error(`seed: link not added (${r.status})`);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  seedLocal();

  fake = new FakeSupabase();
  (supabaseService.getClient as jest.Mock).mockImplementation(() => fake);
  (supabaseService.getAuthSession as jest.Mock).mockResolvedValue({ userId: USER, email: "a@example.test", accessToken: "t" });

  (databaseService.getTransactionById as jest.Mock).mockImplementation(async (id: string) =>
    db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id),
  );
  (databaseService.getTransactionMessages as jest.Mock).mockImplementation(submissionDb.getTransactionMessages);
  (databaseService.getTransactionEmails as jest.Mock).mockImplementation(submissionDb.getTransactionEmails);
  (databaseService.getTransactionAttachments as jest.Mock).mockImplementation(submissionDb.getTransactionAttachments);
  (databaseService.getRawDatabase as jest.Mock).mockImplementation(() => db);
  (databaseService.updateTransaction as jest.Mock).mockImplementation(async (id: string, u: Row) => {
    const keys = Object.keys(u).filter((k) => ["submission_status", "submission_id", "submitted_at"].includes(k));
    if (keys.length) run(`UPDATE transactions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => u[k]), id);
  });

  // BACKLOG-3403: the real uploader's shape, one file per call, stored under
  // the path the manifest declared (buildAttachmentStoragePath).
  (supabaseStorageService.uploadAttachmentWithRetry as jest.Mock).mockImplementation(
    async (org: string, sub: string, id: string, localPath: string, filename: string) => {
      const storagePath = buildAttachmentStoragePath(org, sub, id, filename);
      fake.objects.add(storagePath);
      return { localId: localPath, storagePath, success: true, mimeType: "application/pdf", fileSizeBytes: 2048 };
    },
  );
  // The fixture's local paths stand for files on disk.
  setPreflightStatForTests(async () => ({ size: 2048 }));
  setStageRetryDelaysForTests([0]);
});

/**
 * BACKLOG-3403: Submit is two steps — the pre-flight lists what cannot be sent
 * (here `att-nobytes`, an email attachment never downloaded) and the agent
 * confirms. These controls are about the checklist copy, so they confirm.
 */
async function submitConfirmed() {
  const preflight = await submissionService.preflightSubmission(TX);
  return submissionService.submitTransaction(TX, undefined, {
    // BACKLOG-3764: and the checklist evidence it lists (att-nobytes's link).
    acceptedExclusionKeys: [
      ...preflight.notIncluded.map((i) => i.key),
      ...(preflight.checklistLinkGaps ?? []).map((g) => g.key),
    ],
  });
}
async function resubmitConfirmed() {
  const preflight = await submissionService.preflightSubmission(TX);
  return submissionService.resubmitTransaction(TX, undefined, {
    // BACKLOG-3764: and the checklist evidence it lists (att-nobytes's link).
    acceptedExclusionKeys: [
      ...preflight.notIncluded.map((i) => i.key),
      ...(preflight.checklistLinkGaps ?? []).map((g) => g.key),
    ],
  });
}

afterEach(() => {
  setPreflightStatForTests(null);
  setStageRetryDelaysForTests([1000, 2000]);
  db.close();
});

/** The cloud attachment row a copied link member points at, by its local id. */
function memberLocalIds(itemTitle: string): string[] {
  const item = fake.tables.submission_checklist_items.find((i) => i.title === itemTitle);
  if (!item) return [];
  const links = fake.tables.submission_checklist_links.filter((l) => l.submission_checklist_item_id === item.id);
  return fake.tables.submission_checklist_link_members
    .filter((m) => links.some((l) => l.id === m.link_id))
    .map((m) => {
      if (m.kind === "attachment") {
        return fake.tables.submission_attachments.find((a) => a.id === m.submission_attachment_id)
          ?.local_attachment_id as string;
      }
      return fake.tables.submission_messages.find((x) => x.id === m.submission_message_id)?.local_message_id as string;
    })
    .sort();
}

describe("BACKLOG-3477 — submit copies the transaction's checklists", () => {
  it("copies EVERY checklist, while the submission is uploading, with its evidence linked", async () => {
    await seedChecklists();
    const result = await submitConfirmed();

    expect(result.success).toBe(true);
    const sub = fake.tables.transaction_submissions.find((s) => s.id === result.submissionId)!;
    expect(sub.status).toBe("submitted");

    // One call, made before finalize.
    expect(fake.rpcCalls.map((c) => [c.fn, c.parentStatusAtCall])).toEqual([[SNAPSHOT_RPC, "uploading"]]);

    // Both checklists, in display order.
    expect(
      fake.tables.submission_checklists.map((h) => [h.submission_id, h.template_id, h.template_name, h.sort_order]),
    ).toEqual([
      [sub.id, TPL_PURCHASE, "Residential Purchase", 0],
      [sub.id, TPL_DISCLOSURE, "Seller Disclosures", 1],
    ]);
    expect(
      fake.tables.submission_checklist_items.map((i) => [i.title, i.is_required, i.is_checked, i.note, i.expected_document_type, i.description]),
    ).toEqual([
      ["Signed purchase agreement", true, true, "Both copies", "contract", null],
      ["Earnest money receipt", true, false, null, null, null],
      ["Inspection scheduled", false, false, null, null, "Any inspector"],
      ["Lead paint disclosure", true, false, null, null, null],
    ]);
    expect(fake.tables.submission_checklist_items.every((i) => i.reviewer_checked === false)).toBe(true);
  });

  it("writes local_attachment_id per uploaded row, pairing same-bytes files by row, not by path", async () => {
    await seedChecklists();
    const result = await submitConfirmed();
    expect(result.success).toBe(true);

    // Two uploads of one content-addressed file; each keeps its own local id.
    expect(fake.tables.submission_attachments.map((a) => a.local_attachment_id).sort()).toEqual(["att-fwd", "att-offer"]);

    // Every link resolves to the row it was made against.
    expect(memberLocalIds("Signed purchase agreement")).toEqual(["att-offer"]);
    expect(memberLocalIds("Earnest money receipt")).toEqual(["att-fwd"]);
    expect(memberLocalIds("Inspection scheduled")).toEqual(["e-inspection"]);
    // An attachment whose bytes were never stored was not uploaded: link dropped.
    expect(memberLocalIds("Lead paint disclosure")).toEqual([]);
    expect(fake.tables.submission_checklist_links).toHaveLength(3);
  });

  // BACKLOG-3403 retired "a FAILED upload ahead of a same-bytes pair does not
  // shift the pairing" on purpose. Its premise — a failed upload and the
  // submission still going through — is gone: a failed upload now fails the
  // whole submission, and attachment rows are built from the manifest (one
  // minted row per local attachment, before upload), so there is no
  // upload-result-to-row pairing left to shift. The same-bytes property is
  // still held by the test above.

  it("sends exactly the contract's keys, and no reviewer values", async () => {
    await seedChecklists();
    await submitConfirmed();
    const payload = fake.rpcCalls[0].args.p_checklists as Row[];
    expect(Object.keys(fake.rpcCalls[0].args).sort()).toEqual(["p_checklists", "p_submission_id"]);
    expect(Object.keys(payload[0]).sort()).toEqual(["items", "sort_order", "template_id", "template_name"]);
    const item = (payload[0].items as Row[])[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        "description",
        "expected_document_type",
        "is_checked",
        "is_required",
        "links",
        "local_item_id",
        "note",
        "sort_order",
        "title",
      ],
    );
    expect(Object.keys((item.links as Row[])[0]).sort()).toEqual(["kind", "label", "local_ids", "sort_order"]);
  });

  it("a resubmit writes its own copy onto the new version", async () => {
    await seedChecklists();
    const first = await submitConfirmed();
    expect(first.success).toBe(true);
    fake.tables.transaction_submissions.find((s) => s.id === first.submissionId)!.status = "needs_changes";

    const second = await resubmitConfirmed();
    expect(second.success).toBe(true);
    expect(fake.rpcCalls.map((c) => [c.args.p_submission_id, c.parentStatusAtCall])).toEqual([
      [first.submissionId, "uploading"],
      [second.submissionId, "uploading"],
    ]);
    const perSubmission = (id: unknown) => fake.tables.submission_checklists.filter((h) => h.submission_id === id).length;
    expect([perSubmission(first.submissionId), perSubmission(second.submissionId)]).toEqual([2, 2]);
    expect(fake.tables.transaction_submissions.find((s) => s.id === second.submissionId)!.status).toBe("resubmitted");
  });

  it("a refused copy (plan without checklists) does not fail the submission", async () => {
    await seedChecklists();
    fake.checklistsFeatureAllowed = false;

    const result = await submitConfirmed();

    expect(result.success).toBe(true);
    expect(fake.tables.transaction_submissions.find((s) => s.id === result.submissionId)!.status).toBe("submitted");
    expect(fake.rpcCalls).toHaveLength(1);
    for (const t of ["submission_checklists", "submission_checklist_items", "submission_checklist_links", "submission_checklist_link_members"]) {
      expect([t, fake.tables[t].length]).toEqual([t, 0]);
    }
    const warned = (logService.warn as jest.Mock).mock.calls.find((c) => String(c[0]).includes("Checklists were not copied"));
    expect(warned?.[2]).toMatchObject({ code: "42501" });
  });

  // BACKLOG-3607 (SR C-9): rewritten on purpose from "no checklist on the
  // transaction: no call at all". The snapshot is the agent's whole set, so a
  // transaction with none sends [] and the server records any checklist the
  // agent removed since the previous version.
  it("C9a: no checklist on the transaction -> [] is sent, written, and the agent is told nothing", async () => {
    const result = await submitConfirmed();
    expect(result.success).toBe(true);
    expect("checklistsNotSent" in result).toBe(false);
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0].fn).toBe(SNAPSHOT_RPC);
    expect(fake.rpcCalls[0].args.p_checklists).toEqual([]);
    expect(fake.rpcCalls[0].parentStatusAtCall).toBe("uploading");
    expect(fake.tables.submission_checklists).toHaveLength(0);
    expect(fake.tables.transaction_submissions.map((s) => s.status)).toEqual(["submitted"]);
  });

  it("C9a: the same with the plan off -> the 3607 server accepts [] and the agent is told nothing", async () => {
    // Migration 20260929120000 section 5: no feature and no checklist on the
    // version -> the carry returns {status: 'not_in_plan'}; the snapshot call
    // succeeds with zero counts.
    fake.checklistsFeatureAllowed = false;
    const result = await submitConfirmed();
    expect(result.success).toBe(true);
    expect("checklistsNotSent" in result).toBe(false);
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0].args.p_checklists).toEqual([]);
  });

  it("C9b: a server without the 3607 migration refuses [] with 42501 -> submitted, not retried, no warning, no Sentry", async () => {
    // Before 20260929120000 the carry (20260928170000) checks the feature
    // before anything else: RAISE EXCEPTION 'not_authorized' USING ERRCODE '42501'.
    fake.rpcScript = [{ code: "42501", message: "not_authorized" }];
    const result = await submitConfirmed();
    expect(result.success).toBe(true);
    expect("checklistsNotSent" in result).toBe(false);
    expect(fake.rpcCalls).toHaveLength(1);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(fake.tables.transaction_submissions.map((s) => s.status)).toEqual(["submitted"]);
  });
});

// ============================================================================
// BACKLOG-3596 (PR 2) — each item carries its stable LOCAL id
// ============================================================================
/**
 * Contract: supabase/migrations/20260928120000_backlog_3596_broker_checklist_ticks.sql
 * (PR 1, branch feature-portal/BACKLOG-3596-cloud @ b3d0b912d) §4 reads
 * `items[].local_item_id` as `NULLIF(it ->> 'local_item_id', '')`. The carry
 * (§3) matches an item to the parent version's item on local_item_id AND title
 * AND the header's template_id. A version whose items carry no local_item_id
 * at all takes the branch `ELSIF v_items > 0 AND v_with_ids = 0` and gets one
 * 'checklist_review_unavailable' entry, reason 'unmatched_client'; nothing is
 * carried and nothing is refused.
 *
 * Wrong implementations these catch:
 *   id dropped                       -> nothing ever matches; every tick lost
 *   a fresh id per snapshot          -> v2 never matches v1; every tick lost
 *   the checklist or template id sent in its place
 *                                    -> items of one checklist collide
 */
describe("BACKLOG-3596 — the snapshot sends each item's local id", () => {
  /** Local truth: (template_id, title) -> local item id, read from SQLite. */
  function localItemIds(): Map<string, string> {
    const rows = db
      .prepare(
        `SELECT i.id, i.title, c.template_id FROM transaction_checklist_items i
           JOIN transaction_checklists c ON c.id = i.checklist_id
          WHERE c.transaction_id = ?`,
      )
      .all(TX) as { id: string; title: string; template_id: string }[];
    return new Map(rows.map((r) => [`${r.template_id}|${r.title}`, r.id]));
  }

  function payloadItemIds(payload: Row[]): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const c of payload) {
      for (const it of c.items as Row[]) out.set(`${c.template_id}|${it.title}`, it.local_item_id);
    }
    return out;
  }

  /** A third checklist whose one item has the SAME title as an item on the first. */
  async function seedSameTitleChecklist(): Promise<string> {
    const tpl = randomUUID();
    const r = await selectChecklistTemplate({
      transactionId: TX,
      templateId: tpl,
      templateName: "Broker Addendum",
      items: [{ title: "Signed purchase agreement", isRequired: true, sortOrder: 0 }],
    });
    if (r.status !== "added") throw new Error("seed: template not added");
    return tpl;
  }

  it("every item on every checklist carries its own local item id", async () => {
    await seedChecklists();
    const tplSame = await seedSameTitleChecklist();
    const result = await submitConfirmed();
    expect(result.success).toBe(true);

    const payload = fake.rpcCalls[0].args.p_checklists as Row[];
    const local = localItemIds();
    expect(local.size).toBe(5);
    // Same key set, same ids — every item, every checklist.
    expect(payloadItemIds(payload)).toEqual(local);

    // The same title on two checklists: two different ids, each its own row.
    const a = local.get(`${TPL_PURCHASE}|Signed purchase agreement`);
    const b = local.get(`${tplSame}|Signed purchase agreement`);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);

    // Never a checklist id or a template id in its place.
    const notItemIds = new Set(
      (db.prepare(`SELECT id, template_id FROM transaction_checklists`).all() as Row[]).flatMap((r) => [
        r.id,
        r.template_id,
      ]),
    );
    const sent = [...payloadItemIds(payload).values()];
    expect(new Set(sent).size).toBe(5);
    for (const id of sent) expect(notItemIds.has(id)).toBe(false);

    // What the server stored: one local_item_id per copied item.
    expect(
      fake.tables.submission_checklist_items.map((i) => i.local_item_id).sort(),
    ).toEqual([...local.values()].sort());
  });

  it("the ids are the same on the resubmitted version (stable across snapshots)", async () => {
    await seedChecklists();
    const first = await submitConfirmed();
    expect(first.success).toBe(true);
    fake.tables.transaction_submissions.find((s) => s.id === first.submissionId)!.status = "needs_changes";
    const second = await resubmitConfirmed();
    expect(second.success).toBe(true);

    expect(fake.rpcCalls).toHaveLength(2);
    const v1 = payloadItemIds(fake.rpcCalls[0].args.p_checklists as Row[]);
    const v2 = payloadItemIds(fake.rpcCalls[1].args.p_checklists as Row[]);
    expect(v1.size).toBe(4);
    expect(v2).toEqual(v1);
    expect(v1).toEqual(localItemIds());

    const stored = (sid: unknown) =>
      fake.tables.submission_checklist_items
        .filter((i) => i.submission_id === sid)
        .map((i) => [i.title, i.local_item_id]);
    expect(stored(second.submissionId)).toEqual(stored(first.submissionId));
  });

  it("an older-app payload without local_item_id is still accepted, stored as NULL", async () => {
    await seedChecklists();
    // Premise: today's builder sends a non-empty id on every item.
    const built = buildChecklistSnapshotPayload(await getChecklistsForTransaction(TX));
    const builtItems = built.flatMap((c) => c.items);
    expect(builtItems).toHaveLength(4);
    for (const it of builtItems) expect(typeof it.local_item_id === "string" && it.local_item_id.length > 0).toBe(true);

    // The pre-3596 shape: the same payload with the key removed.
    const older = built.map((c) => ({
      ...c,
      items: c.items.map(({ local_item_id: _drop, ...rest }) => rest),
    })) as unknown as SnapshotChecklistPayload[];
    expect(older.flatMap((c) => c.items).some((it) => "local_item_id" in it)).toBe(false);

    const sid = "sub-older-app";
    fake.tables.transaction_submissions.push({ id: sid, submitted_by: USER, status: "uploading" });
    const { error } = await fake.rpc(SNAPSHOT_RPC, { p_submission_id: sid, p_checklists: older });
    expect(error).toBeNull();
    const stored = fake.tables.submission_checklist_items.filter((i) => i.submission_id === sid);
    expect(stored).toHaveLength(4);
    expect(stored.every((i) => i.local_item_id === null)).toBe(true);
  });
});

// ============================================================================
// BACKLOG-3600 — a checklist copy that fails on the network fails the submit
// ============================================================================
/**
 * Wrong implementations these catch (plan 62c658e1, SR conditions 486eefd9):
 *   warning shown on a network failure (submits anyway)   -> D1
 *   the retry re-runs the attachment upload / insert      -> D2
 *   a 23505 after a lost response treated as a failure    -> D3
 *   42501 (plan without checklists) retried or blocking   -> D4
 *   a 23505 on the FIRST call treated as written          -> D7
 *   an attempt that hangs forever                         -> D6
 */
describe("BACKLOG-3600 — the checklist copy is retried, then fails the submit", () => {
  const saved = { ...SNAPSHOT_RETRY, backoffMs: [...SNAPSHOT_RETRY.backoffMs] };
  beforeEach(() => {
    SNAPSHOT_RETRY.attempts = 3;
    SNAPSHOT_RETRY.attemptTimeoutMs = 2000;
    SNAPSHOT_RETRY.backoffMs = [1, 1];
  });
  afterAll(() => {
    Object.assign(SNAPSHOT_RETRY, saved);
  });

  const copyRows = () =>
    ["submission_checklists", "submission_checklist_items", "submission_checklist_links", "submission_checklist_link_members"].map(
      (t) => [t, fake.tables[t].length],
    );
  const localStatus = () =>
    (db.prepare(`SELECT submission_status, submission_id FROM transactions WHERE id = ?`).get(TX) as Row);

  it("D1: network failure on every attempt -> nothing submitted, the agent is told why, no warning field", async () => {
    await seedChecklists();
    fake.rpcScript = ["network", "network", "network"];
    const before = localStatus();

    const result = await submitConfirmed();

    expect(result.success).toBe(false);
    expect(result.error).toBe(CHECKLISTS_NOT_SENT_ERROR);
    expect("checklistsNotSent" in result).toBe(false);
    expect(fake.rpcCalls).toHaveLength(3);
    // The uploading row is gone: the broker never sees a version.
    expect(fake.tables.transaction_submissions).toHaveLength(0);
    expect(copyRows()).toEqual(copyRows().map(([t]) => [t, 0]));
    expect(localStatus()).toEqual(before);
    // The failure text is what the modal shows and what error_logs records.
    expect(fake.tables.error_logs.map((e) => e.error_message)).toEqual([CHECKLISTS_NOT_SENT_ERROR]);
  });

  it("D2: one network failure, then success -> submitted with one copy; the attachments were uploaded once", async () => {
    await seedChecklists();
    fake.rpcScript = ["network"];

    const result = await submitConfirmed();

    expect(result.success).toBe(true);
    expect("checklistsNotSent" in result).toBe(false);
    expect(fake.rpcCalls).toHaveLength(2);
    // The SAME payload object on both attempts: no second local read.
    expect(fake.rpcCalls[1].args.p_checklists).toBe(fake.rpcCalls[0].args.p_checklists);
    expect(fake.tables.submission_checklists).toHaveLength(2);
    expect(fake.tables.transaction_submissions.map((s) => s.status)).toEqual(["submitted"]);
    // The retry did not re-run anything upstream of it.
    // BACKLOG-3403: one upload per sendable attachment (att-offer, att-fwd).
    expect(supabaseStorageService.uploadAttachmentWithRetry as jest.Mock).toHaveBeenCalledTimes(2);
    expect(fake.insertCalls.submission_attachments).toBe(1);
    expect(fake.tables.submission_attachments).toHaveLength(2);
  });

  it("D3: the first call commits and its answer is lost -> the retry's 23505 counts as written", async () => {
    await seedChecklists();
    fake.rpcScript = ["lost"];

    const result = await submitConfirmed();

    expect(result.success).toBe(true);
    expect("checklistsNotSent" in result).toBe(false);
    expect(fake.rpcCalls).toHaveLength(2);
    // Exactly one copy: the first call's.
    expect(fake.tables.submission_checklists).toHaveLength(2);
    expect(fake.tables.submission_checklist_items).toHaveLength(4);
    expect(fake.tables.transaction_submissions.map((s) => s.status)).toEqual(["submitted"]);
  });

  it("D4: plan without checklists -> submitted with not_in_plan, not retried", async () => {
    await seedChecklists();
    fake.checklistsFeatureAllowed = false;

    const result = await submitConfirmed();

    expect(result.success).toBe(true);
    expect(result.checklistsNotSent).toBe("not_in_plan");
    expect(fake.rpcCalls).toHaveLength(1);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("D7: a 23505 on the FIRST call is drift -> submitted with refused, reported, not retried", async () => {
    await seedChecklists();
    fake.rpcScript = [{ code: "23505", message: "duplicate key value violates unique constraint" }];

    const result = await submitConfirmed();

    expect(result.success).toBe(true);
    expect(result.checklistsNotSent).toBe("refused");
    expect(fake.rpcCalls).toHaveLength(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("D6: an attempt that never answers is cut off, and the submit fails within the bound", async () => {
    await seedChecklists();
    SNAPSHOT_RETRY.attemptTimeoutMs = 50;
    fake.rpcScript = ["hang", "hang", "hang"];

    const started = Date.now();
    const result = await submitConfirmed();

    expect(result.success).toBe(false);
    expect(result.error).toBe(CHECKLISTS_NOT_SENT_ERROR);
    expect(fake.rpcCalls).toHaveLength(3);
    expect(fake.tables.transaction_submissions).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  // BACKLOG-3599 item 1: each transient class, one failure then success. The
  // shape `{ code, message }` is the fake's PgError, as in D7; the texts are
  // the standard PostgREST / Postgres messages for each code.
  it.each([
    ["PGRST003", "Timed out acquiring connection from connection pool."],
    ["08006", "connection failure"],
    ["40001", "could not serialize access due to concurrent update"],
    ["57014", "canceling statement due to statement timeout"],
    ["53300", "sorry, too many clients already"],
    ["PGRST204", "Could not find the 'notes' column of 'submission_checklists' in the schema cache"],
  ])("G1: %s once, then success -> retried and submitted with the copy", async (code, message) => {
    await seedChecklists();
    fake.rpcScript = [{ code, message }];

    const result = await submitConfirmed();

    expect(result.success).toBe(true);
    expect("checklistsNotSent" in result).toBe(false);
    expect(fake.rpcCalls).toHaveLength(2);
    expect(fake.tables.submission_checklists).toHaveLength(2);
  });

  // BACKLOG-3599 item 2: schema drift no retry can fix -> refused on the first
  // call, reported once, the submit goes through with the notice.
  it.each([
    ["PGRST202", "Could not find the function public.snapshot_submission_checklists(p_checklists, p_submission_id) in the schema cache"],
    ["PGRST203", "Could not choose the best candidate function between: public.snapshot_submission_checklists(p_submission_id => uuid, p_checklists => jsonb), public.snapshot_submission_checklists(p_submission_id => text, p_checklists => jsonb)"],
  ])("G1b: %s -> submitted with refused, one call, one Sentry event", async (code, message) => {
    await seedChecklists();
    fake.rpcScript = [{ code, message }];

    const result = await submitConfirmed();

    expect(result.success).toBe(true);
    expect(result.checklistsNotSent).toBe("refused");
    expect(fake.rpcCalls).toHaveLength(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(fake.tables.transaction_submissions.map((s) => s.status)).toEqual(["submitted"]);
  });

  it("C9b: a transient failure on [] still fails the submit (nothing reaches the broker)", async () => {
    fake.rpcScript = ["network", "network", "network"];
    const result = await submitConfirmed();
    expect(result.success).toBe(false);
    expect(result.error).toBe(CHECKLISTS_NOT_SENT_ERROR);
    expect(fake.rpcCalls).toHaveLength(3);
    expect(fake.rpcCalls.every((c) => Array.isArray(c.args.p_checklists) && (c.args.p_checklists as unknown[]).length === 0)).toBe(true);
    expect(fake.tables.transaction_submissions).toHaveLength(0);
  });

  it("G2: the local checklist read fails -> nothing submitted, the agent is told why, no call", async () => {
    await seedChecklists();
    const spy = jest
      .spyOn(checklistDbModule, "getChecklistsForTransaction")
      .mockRejectedValue(new Error("SQLITE_BUSY: database is locked"));
    try {
      const result = await submitConfirmed();

      expect(spy).toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toBe(CHECKLISTS_NOT_SENT_ERROR);
      expect(fake.rpcCalls).toHaveLength(0);
      expect(fake.tables.transaction_submissions).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("a resubmit that loses the network on every attempt leaves the earlier version and local state alone", async () => {
    await seedChecklists();
    const first = await submitConfirmed();
    expect(first.success).toBe(true);
    fake.tables.transaction_submissions.find((s) => s.id === first.submissionId)!.status = "needs_changes";
    run(`UPDATE transactions SET submission_status = 'needs_changes' WHERE id = ?`, TX);
    // The script is indexed by call number; call 1 was the first submit.
    fake.rpcScript = [undefined, "network", "network", "network"];

    const second = await resubmitConfirmed();

    expect(second.success).toBe(false);
    expect(second.error).toBe(CHECKLISTS_NOT_SENT_ERROR);
    expect(fake.tables.transaction_submissions.map((s) => [s.id, s.status])).toEqual([
      [first.submissionId, "needs_changes"],
    ]);
    expect(localStatus()).toEqual({ submission_status: "needs_changes", submission_id: first.submissionId });
  });
});

// ============================================================================
// BACKLOG-3599 — a resubmit first tries a broker checklist pull that is owed
// ============================================================================
describe("BACKLOG-3599 — resubmit with an owed broker checklist pull", () => {
  const TPL_BROKER = randomUUID();

  /** v1 submitted, the broker added a checklist at review, the pull is owed. */
  async function submittedWithOwedPull(): Promise<string> {
    await seedChecklists();
    const first = await submitConfirmed();
    expect(first.success).toBe(true);
    const sid = first.submissionId!;
    fake.tables.transaction_submissions.find((s) => s.id === sid)!.status = "needs_changes";
    run(`UPDATE transactions SET submission_status = 'needs_changes' WHERE id = ?`, TX);
    // Shape transcribed from the sync-back suite's fixture (one live
    // broker-added header + items, read 2026-09-27).
    fake.tables.submission_checklists.push({
      id: "hdr-broker-3599",
      submission_id: sid,
      template_id: TPL_BROKER,
      template_name: "Broker review add",
      sort_order: 2,
      added_at_review_by: "broker-3599",
      added_at_review_at: "2026-09-27 23:04:54.012711+00",
      removed_at_review_by: null,
      removed_at_review_at: null,
    });
    fake.tables.submission_checklist_items.push({
      id: "item-broker-3599",
      submission_id: sid,
      submission_checklist_id: "hdr-broker-3599",
      title: "HOA estoppel letter",
      description: null,
      is_required: true,
      expected_document_type: null,
      sort_order: 10,
    });
    expect(markReviewChecklistPullOwed(TX, sid)).toBe(true);
    return sid;
  }

  it("C8: the owed pull lands first, so the new version's snapshot carries the broker checklist", async () => {
    const v1 = await submittedWithOwedPull();

    const second = await resubmitConfirmed();

    expect(second.success).toBe(true);
    expect("checklistsNotSent" in second).toBe(false);
    const payload = fake.rpcCalls[fake.rpcCalls.length - 1].args.p_checklists as Row[];
    expect(payload.map((c) => c.template_id)).toContain(TPL_BROKER);
    expect(getOwedReviewChecklistPullsFor(TX)).toEqual([]);
    // Before Stage 1: no uploading row existed while the pull read the cloud
    // (BACKLOG-3607: two header reads per pull, added and removed).
    expect(fake.uploadingAtChecklistRead).toEqual([0, 0]);
    expect(fake.tables.transaction_submissions.map((s) => [s.id === v1, s.status])).toEqual([
      [true, "needs_changes"],
      [false, "resubmitted"],
    ]);
  });

  it("the owed pull fails -> the resubmit still succeeds, says so, and keeps the pull owed", async () => {
    const v1 = await submittedWithOwedPull();
    fake.failReadsOf.add("submission_checklists");

    const second = await resubmitConfirmed();

    expect(second.success).toBe(true);
    expect(second.checklistsNotSent).toBe("brokerChecklistsNotDownloaded");
    const payload = fake.rpcCalls[fake.rpcCalls.length - 1].args.p_checklists as Row[];
    expect(payload.map((c) => c.template_id)).not.toContain(TPL_BROKER);
    expect(getOwedReviewChecklistPullsFor(TX)).toEqual([v1]);
  });

  it("G3: the owed pull fails AND the plan refuses the copy -> the plan's reason is kept", async () => {
    await submittedWithOwedPull();
    fake.failReadsOf.add("submission_checklists");
    fake.checklistsFeatureAllowed = false;

    const second = await resubmitConfirmed();

    expect(second.success).toBe(true);
    expect(second.checklistsNotSent).toBe("not_in_plan");
  });

  // BACKLOG-3607 (SR B-1): the owed pull is for v1, but v2 already exists in
  // the cloud. v1's broker removal must not reach the local set behind v2.
  it("C-B1e: an owed pull for v1 after v2 exists is dropped at the next resubmit; v3 still carries the checklist", async () => {
    await seedChecklists();
    const first = await submitConfirmed();
    expect(first.success).toBe(true);
    const v1 = first.submissionId!;
    fake.tables.transaction_submissions.find((s) => s.id === v1)!.status = "needs_changes";
    run(`UPDATE transactions SET submission_status = 'needs_changes' WHERE id = ?`, TX);
    const disclosure = fake.tables.submission_checklists.find(
      (h) => h.submission_id === v1 && h.template_id === TPL_DISCLOSURE,
    )!;
    disclosure.removed_at_review_by = "broker-3607";
    disclosure.removed_at_review_at = "2026-09-29 10:15:00+00";
    expect(markReviewChecklistPullOwed(TX, v1)).toBe(true);

    // v2: the pre-pull fails, so v2 is sent WITH the checklist and v1 stays owed.
    fake.failReadsOf.add("submission_checklists");
    const second = await resubmitConfirmed();
    expect(second.success).toBe(true);
    expect(second.checklistsNotSent).toBe("brokerChecklistsNotDownloaded");
    expect(getOwedReviewChecklistPullsFor(TX)).toEqual([v1]);
    const v2Row = fake.tables.transaction_submissions.find((s) => s.id === second.submissionId)!;
    expect(v2Row.parent_submission_id).toBe(v1);
    fake.failReadsOf.delete("submission_checklists");
    v2Row.status = "needs_changes";
    run(`UPDATE transactions SET submission_status = 'needs_changes' WHERE id = ?`, TX);
    const callsBefore = fake.rpcCalls.length;

    const third = await resubmitConfirmed();

    expect(third.success).toBe(true);
    expect("checklistsNotSent" in third).toBe(false);
    expect(fake.rpcCalls.length).toBe(callsBefore + 1);
    const payload = fake.rpcCalls[fake.rpcCalls.length - 1].args.p_checklists as Row[];
    expect(payload.map((c) => c.template_id).sort()).toEqual([TPL_DISCLOSURE, TPL_PURCHASE].sort());
    expect(getOwedReviewChecklistPullsFor(TX)).toEqual([]);
  });

  // BACKLOG-3607 (SR R-1): the resubmit guard is released however the
  // resubmit ends, so the next sync pass pulls normally.
  it("C-R1c: a resubmit that FAILS releases the guard -> the next sync-pass pull lands", async () => {
    const v1 = await submittedWithOwedPull();
    fake.failReadsOf.add("submission_checklists");
    // The script is indexed by call number; call 1 was the first submit.
    fake.rpcScript = [undefined, "network", "network", "network"];

    const second = await resubmitConfirmed();

    expect(second.success).toBe(false);
    expect(getOwedReviewChecklistPullsFor(TX)).toEqual([v1]);
    fake.failReadsOf.delete("submission_checklists");

    const outcome = await retryOwedReviewChecklistPull(supabaseService.getClient(), TX, v1);

    expect(outcome).toEqual({ status: "pulled", added: ["Broker review add"], removed: [] });
    expect(getOwedReviewChecklistPullsFor(TX)).toEqual([]);
  });

  it("C-R1a (via resubmit): a sync-pass pull during the resubmit writes nothing and stays owed", async () => {
    const v1 = await submittedWithOwedPull();
    fake.failReadsOf.add("submission_checklists");
    type Internal = { submitTransactionInternal: (...args: unknown[]) => Promise<unknown> };
    const internal = submissionService as unknown as Internal;
    const original = internal.submitTransactionInternal.bind(submissionService);
    let during: unknown = null;
    const spy = jest
      .spyOn(internal, "submitTransactionInternal")
      .mockImplementationOnce(async (...args: unknown[]) => {
        // The pre-pull has failed; the network is back while the resubmit
        // runs, and the periodic sync pass retries the owed pull.
        fake.failReadsOf.delete("submission_checklists");
        during = await retryOwedReviewChecklistPull(supabaseService.getClient(), TX, v1);
        return original(...args);
      });
    let second: Awaited<ReturnType<typeof submissionService.resubmitTransaction>>;
    try {
      second = await resubmitConfirmed();
    } finally {
      spy.mockRestore();
    }

    expect(during).toEqual({ status: "kept", reason: `resubmit in progress for ${TX}; nothing written` });
    expect(second.success).toBe(true);
    const payload = fake.rpcCalls[fake.rpcCalls.length - 1].args.p_checklists as Row[];
    expect(payload.map((c) => c.template_id)).not.toContain(TPL_BROKER);
    const local = db
      .prepare("SELECT template_id FROM transaction_checklists WHERE transaction_id = ?")
      .all(TX) as Array<{ template_id: string }>;
    expect(local.length).toBeGreaterThan(0);
    expect(local.map((c) => c.template_id)).not.toContain(TPL_BROKER);
    expect(getOwedReviewChecklistPullsFor(TX)).toEqual([v1]);
  });

  it("C-R1c: a resubmit that THROWS releases the guard -> the next sync-pass pull lands", async () => {
    const v1 = await submittedWithOwedPull();
    fake.failReadsOf.add("submission_checklists");
    const spy = jest
      .spyOn(
        submissionService as unknown as { submitTransactionInternal: () => Promise<unknown> },
        "submitTransactionInternal",
      )
      .mockRejectedValueOnce(new Error("boom"));
    try {
      await expect(resubmitConfirmed()).rejects.toThrow("boom");
    } finally {
      spy.mockRestore();
    }
    fake.failReadsOf.delete("submission_checklists");

    const outcome = await retryOwedReviewChecklistPull(supabaseService.getClient(), TX, v1);

    expect(outcome).toEqual({ status: "pulled", added: ["Broker review add"], removed: [] });
    expect(getOwedReviewChecklistPullsFor(TX)).toEqual([]);
  });

  it("SR-X1: sync pass during Stages 3-6, then the resubmit FAILS -> v1's pull is still owed", async () => {
    const v1 = await submittedWithOwedPull();
    fake.failReadsOf.add("submission_checklists");
    fake.rpcScript = [undefined, "network", "network", "network"];
    const realRpc = fake.rpc.bind(fake);
    let during: unknown = null;
    let ran = false;
    const spy = jest.spyOn(fake, "rpc").mockImplementation(async (fn: string, args: Row) => {
      // The snapshot call is the one inside Stages 3-6; any other RPC the
      // submit path makes (BACKLOG-3519's split resolution) is not.
      if (!ran && fn === SNAPSHOT_RPC) {
        ran = true;
        expect(fake.tables.transaction_submissions.filter((s) => s.status === "uploading")).toHaveLength(1);
        fake.failReadsOf.delete("submission_checklists");
        during = await retryOwedReviewChecklistPull(supabaseService.getClient(), TX, v1);
      }
      return realRpc(fn, args);
    });
    let second: Awaited<ReturnType<typeof submissionService.resubmitTransaction>>;
    try {
      second = await resubmitConfirmed();
    } finally {
      spy.mockRestore();
    }
    expect(ran).toBe(true);
    expect(second.success).toBe(false);
    expect(fake.tables.transaction_submissions.filter((s) => s.status === "uploading")).toHaveLength(0);
    expect(during).toEqual({ status: "kept", reason: `resubmit in progress for ${TX}; nothing written` });
    expect(getOwedReviewChecklistPullsFor(TX)).toEqual([v1]);
  });

  function leaveStaleUploading(v1: string): void {
    const v1row = fake.tables.transaction_submissions.find((s) => s.id === v1)!;
    fake.tables.transaction_submissions.push({ ...v1row, id: "stale-uploading-v2", status: "uploading", parent_submission_id: v1, version: 2 });
  }

  it("SR-X2: a leftover `uploading` child (crash / failed cleanup), next sync pass -> v1's changes are pulled", async () => {
    const v1 = await submittedWithOwedPull();
    leaveStaleUploading(v1);
    const outcome = await retryOwedReviewChecklistPull(supabaseService.getClient(), TX, v1);
    expect(outcome).toEqual({ status: "pulled", added: ["Broker review add"], removed: [] });
    expect(getOwedReviewChecklistPullsFor(TX)).toEqual([]);
  });

  it("SR-X3: a leftover `uploading` child, then resubmit -> v2 carries v1's broker checklist, no warning", async () => {
    const v1 = await submittedWithOwedPull();
    leaveStaleUploading(v1);
    const second = await resubmitConfirmed();
    expect(second.success).toBe(true);
    expect("checklistsNotSent" in second).toBe(false);
    const payload = fake.rpcCalls[fake.rpcCalls.length - 1].args.p_checklists as Row[];
    expect(payload.map((c) => c.template_id)).toContain(TPL_BROKER);
    expect(fake.tables.transaction_submissions.some((s) => s.id === "stale-uploading-v2")).toBe(false);
  });

  describe("BACKLOG-3595 — an open window is told after the pre-pull commits", () => {
    let sent: Array<{ channel: string; rowsAtSend: number; payload: unknown }>;
    const localChecklistCount = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM transaction_checklists WHERE transaction_id = ?").get(TX) as {
        n: number;
      }).n;
    beforeEach(() => {
      sent = [];
      jest.mocked(sendToMainWindow).mockImplementation((channel: string, payload?: unknown) => {
        sent.push({ channel, rowsAtSend: localChecklistCount(), payload });
        return true;
      });
    });

    it("the pre-pull adds the broker checklist -> transaction-checklists-changed once, after the write, no status event", async () => {
      await submittedWithOwedPull();
      const before = localChecklistCount();

      const second = await resubmitConfirmed();

      expect(second.success).toBe(true);
      expect(sent).toEqual([
        { channel: "transaction-checklists-changed", rowsAtSend: before + 1, payload: { transactionId: TX } },
      ]);
    });

    // BACKLOG-3607: the broker removed the agent's Seller Disclosures checklist
    // at review (migration 20260929120000 section 6 sets both markers).
    it("the pre-pull only REMOVES a checklist -> transaction-checklists-changed once, after the delete; the new version omits it", async () => {
      await seedChecklists();
      const first = await submitConfirmed();
      expect(first.success).toBe(true);
      const sid = first.submissionId!;
      fake.tables.transaction_submissions.find((s) => s.id === sid)!.status = "needs_changes";
      run(`UPDATE transactions SET submission_status = 'needs_changes' WHERE id = ?`, TX);
      const disclosure = fake.tables.submission_checklists.find(
        (h) => h.submission_id === sid && h.template_id === TPL_DISCLOSURE,
      )!;
      disclosure.removed_at_review_by = "broker-3607";
      disclosure.removed_at_review_at = "2026-09-29 10:15:00+00";
      expect(markReviewChecklistPullOwed(TX, sid)).toBe(true);
      const before = localChecklistCount();

      const second = await resubmitConfirmed();

      expect(second.success).toBe(true);
      expect("checklistsNotSent" in second).toBe(false);
      expect(sent).toEqual([
        { channel: "transaction-checklists-changed", rowsAtSend: before - 1, payload: { transactionId: TX } },
      ]);
      const payload = fake.rpcCalls[fake.rpcCalls.length - 1].args.p_checklists as Row[];
      expect(payload.map((c) => c.template_id)).toEqual([TPL_PURCHASE]);
      expect(getOwedReviewChecklistPullsFor(TX)).toEqual([]);
    });

    it("the pre-pull fails -> nothing is sent", async () => {
      await submittedWithOwedPull();
      fake.failReadsOf.add("submission_checklists");

      await resubmitConfirmed();

      expect(sent).toEqual([]);
    });
  });

  it("nothing owed -> no pull, no field", async () => {
    await seedChecklists();
    const first = await submitConfirmed();
    fake.tables.transaction_submissions.find((s) => s.id === first.submissionId)!.status = "needs_changes";
    run(`UPDATE transactions SET submission_status = 'needs_changes' WHERE id = ?`, TX);

    const second = await resubmitConfirmed();

    expect(second.success).toBe(true);
    expect("checklistsNotSent" in second).toBe(false);
    expect(fake.uploadingAtChecklistRead).toEqual([]);
  });
});

// ============================================================================
// BACKLOG-3764 — checklist links to evidence dated outside the audit dates.
// SR plan ruling pm_comments a0241e2d on BACKLOG-3764: controls C1, C2, C3,
// C6, C7, C8, C9, C10 (C4 picker, C5 boundary sweep and C11 upgrade path live
// in their own files). Same harness: real schema, real checklist service, real
// readers, the cloud function emulated as transcribed above.
// ============================================================================
describe("BACKLOG-3764 — out-of-dates checklist evidence is asked about, never dropped silently", () => {
  /** The date step's real writer (main side of `saveConfirmedTransactionDates`). */
  const transactionDb = jest.requireActual("../db/transactionDbService") as typeof import("../db/transactionDbService");
  const setDates = (started: string, closed: string) =>
    transactionDb.updateTransaction(TX, { started_at: started, closed_at: closed, closing_date_verified: 1 } as never);

  const itemId = (title: string) =>
    (db.prepare(`SELECT id FROM transaction_checklist_items WHERE title = ?`).get(title) as { id: string }).id;
  const linkRows = () => db.prepare(`SELECT id, include_outside_dates FROM transaction_checklist_links ORDER BY id`).all();
  const memberCount = () =>
    (db.prepare(`SELECT count(*) AS n FROM transaction_checklist_link_members`).get() as { n: number }).n;
  const uploadedEmails = () =>
    fake.tables.submission_messages.filter((m) => m.channel === "email").map((m) => m.local_message_id as string).sort();
  const uploadedAttachments = () =>
    fake.tables.submission_attachments.map((a) => a.local_attachment_id as string).sort();
  /** Every cloud link member, as `label:local id`. */
  const cloudLinkMembers = () => {
    const links = new Map(fake.tables.submission_checklist_links.map((l) => [l.id, l.label]));
    const msgs = new Map(fake.tables.submission_messages.map((m) => [m.id, m.local_message_id]));
    const atts = new Map(fake.tables.submission_attachments.map((a) => [a.id, a.local_attachment_id]));
    return fake.tables.submission_checklist_link_members
      .map((m) => `${links.get(m.link_id as string)}:${
        m.submission_message_id ? msgs.get(m.submission_message_id as string) : atts.get(m.submission_attachment_id as string)
      }`)
      .sort();
  };

  /** Submit, confirming exactly what the pre-flight lists (files and links). */
  async function submitAcceptingPreflight() {
    const preflight = await submissionService.preflightSubmission(TX);
    const result = await submissionService.submitTransaction(TX, undefined, {
      acceptedExclusionKeys: [
        ...preflight.notIncluded.map((i) => i.key),
        ...(preflight.checklistLinkGaps ?? []).map((g) => g.key),
      ],
    });
    return { preflight, result };
  }

  beforeEach(async () => {
    // An email AFTER the closing date, with two files, on the same deal.
    run(
      `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, sent_at, has_attachments)
       VALUES ('e-late', ?, 'ext-e-late', 'gmail', 'acct', 'Late repair invoice', 'l@example.com', 'a@example.test', '2026-04-10T15:00:00.000Z', 1),
              ('e-late2', ?, 'ext-e-late2', 'gmail', 'acct', 'Late HOA letter', 'l@example.com', 'a@example.test', '2026-04-11T15:00:00.000Z', 0)`,
      USER, USER,
    );
    run(`INSERT INTO communications (id, user_id, transaction_id, email_id, link_source) VALUES ('c-late', ?, ?, 'e-late', 'manual'), ('c-late2', ?, ?, 'e-late2', 'manual')`, USER, TX, USER, TX);
    run(
      `INSERT INTO attachments (id, email_id, filename, mime_type, storage_path, created_at) VALUES
         ('att-late', 'e-late', 'invoice.pdf', 'application/pdf', '/attachments/aa01.pdf', '2026-04-10T15:00:00Z'),
         ('att-late-2', 'e-late', 'photos.pdf', 'application/pdf', '/attachments/aa02.pdf', '2026-04-10T15:00:01Z')`,
    );
    await seedChecklists();
    // Dates as the date step saves them (date-only), March.
    await setDates("2026-03-01", "2026-03-31");
  });

  it("C9: an out-of-dates link without a yes is refused as outside_dates and writes NOTHING", async () => {
    const linksBefore = linkRows();
    const membersBefore = memberCount();
    const r = await addChecklistLink({ itemId: itemId("Earnest money receipt"), kind: "email", targetIds: ["e-late"] });
    expect(r).toEqual({
      status: "outside_dates",
      outside: [{ id: "e-late", sentAt: "2026-04-10T15:00:00.000Z" }],
      auditStart: "2026-03-01",
      auditEnd: "2026-03-31",
    });
    expect(linkRows()).toEqual(linksBefore);
    expect(memberCount()).toBe(membersBefore);
  });

  it("C3 + C10: a yes is stored on the link, and the email AND its files are sent and attached", async () => {
    const r = await addChecklistLink({
      itemId: itemId("Earnest money receipt"),
      kind: "email",
      targetIds: ["e-late"],
      includeOutsideDates: true,
    });
    expect(r.status).toBe("added");
    const { result } = await submitAcceptingPreflight();
    expect(result.success).toBe(true);
    expect(uploadedEmails()).toEqual(["e-fwd", "e-inspection", "e-late", "e-offer"]);
    // C10: the flagged email's files come with it.
    expect(uploadedAttachments()).toEqual(["att-fwd", "att-late", "att-late-2", "att-offer"]);
    expect(cloudLinkMembers()).toContain("Late repair invoice:e-late");
    expect(result.checklistLinksNotAttached).toBeUndefined();
  });

  it("C6: after a yes on one link, a second out-of-dates link on the SAME item is still asked about", async () => {
    const item = itemId("Earnest money receipt");
    const first = await addChecklistLink({ itemId: item, kind: "email", targetIds: ["e-late"], includeOutsideDates: true });
    expect(first.status).toBe("added");
    const second = await addChecklistLink({ itemId: item, kind: "email", targetIds: ["e-late2"] });
    expect(second.status).toBe("outside_dates");
  });

  it("C2 (+C1): a link made in the dates, pushed outside by the date step, is NOT sent without a yes, and is listed", async () => {
    // e-fwd (sent 2 Mar) is linked while inside; the date step then ends the deal on 1 Mar.
    await setDates("2026-03-01", "2026-03-01");
    const { preflight, result } = await submitAcceptingPreflight();
    const outside = (preflight.checklistLinkGaps ?? []).filter((g) => g.reason === "outside_audit_dates");
    expect(outside.map((g) => [g.itemTitle, g.missingIds])).toEqual([
      ["Earnest money receipt", ["att-fwd"]],
      ["Inspection scheduled", ["e-inspection"]],
    ]);
    expect(result.success).toBe(true);
    // C2: nothing outside the dates was sent without a yes.
    expect(uploadedEmails()).toEqual(["e-offer"]);
    expect(uploadedAttachments()).toEqual(["att-offer"]);
    // C1: nothing the agent was not told about was dropped.
    expect(fake.rpcCalls).toHaveLength(1);
    expect(result.checklistLinksNotAttached).toBeUndefined();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("pre-flight Include it: the answer is stored on that link, the question goes, and the email is sent", async () => {
    await setDates("2026-03-01", "2026-03-01");
    const first = await submissionService.preflightSubmission(TX);
    const gap = (first.checklistLinkGaps ?? []).find((g) => g.itemTitle === "Inspection scheduled")!;
    expect(gap.reason).toBe("outside_audit_dates");
    // Another deal's id is refused: only a link on THIS transaction changes.
    expect(await setChecklistLinkIncludeOutsideDates("txn-other", gap.linkId)).toBe(false);
    expect(await setChecklistLinkIncludeOutsideDates(TX, gap.linkId)).toBe(true);
    const { preflight, result } = await submitAcceptingPreflight();
    expect((preflight.checklistLinkGaps ?? []).map((g) => g.itemTitle)).not.toContain("Inspection scheduled");
    expect(result.success).toBe(true);
    expect(uploadedEmails()).toEqual(["e-inspection", "e-offer"]);
    expect(cloudLinkMembers()).toContain("Inspection booked:e-inspection");
  });

  it("a yes on ANOTHER deal's checklist does not send that email with this deal", async () => {
    // The other deal has dates too, so its yes is a real stored answer (a
    // link made with no question stores none).
    run(`INSERT INTO transactions (id, user_id, property_address, started_at, closed_at) VALUES ('txn-other', ?, '9 Other St', '2026-03-01', '2026-03-31')`, USER);
    run(`INSERT INTO communications (id, user_id, transaction_id, email_id, link_source) VALUES ('c-late-other', ?, 'txn-other', 'e-late', 'manual')`, USER);
    const other = await selectChecklistTemplate({
      transactionId: "txn-other",
      templateId: TPL_PURCHASE,
      templateName: "Residential Purchase",
      items: [{ title: "Other deal item", isRequired: true, sortOrder: 0 }],
    });
    expect(other.status).toBe("added");
    const r = await addChecklistLink({ itemId: itemId("Other deal item"), kind: "email", targetIds: ["e-late"], includeOutsideDates: true });
    expect(r.status).toBe("added");
    expect(db.prepare(`SELECT count(*) AS n FROM transaction_checklist_links WHERE include_outside_dates = 1`).get()).toEqual({ n: 1 });
    const { result } = await submitAcceptingPreflight();
    expect(result.success).toBe(true);
    expect(uploadedEmails()).not.toContain("e-late");
    expect(uploadedAttachments()).not.toContain("att-late");
  });

  it("an unconfirmed link gap refuses the submit and returns the list again (nothing sent)", async () => {
    await setDates("2026-03-01", "2026-03-01");
    const preflight = await submissionService.preflightSubmission(TX);
    const result = await submissionService.submitTransaction(TX, undefined, {
      acceptedExclusionKeys: preflight.notIncluded.map((i) => i.key),
    });
    expect(result.success).toBe(false);
    expect(result.preflightChanged).toBe(true);
    expect((result.checklistLinkGaps ?? []).length).toBeGreaterThan(0);
    expect(fake.tables.transaction_submissions).toHaveLength(0);
  });

  it("C7: the date-step summary counts a flagged out-of-dates email (scope == what is sent)", async () => {
    await addChecklistLink({ itemId: itemId("Earnest money receipt"), kind: "email", targetIds: ["e-late"], includeOutsideDates: true });
    const scope = await submissionService.getSubmissionScope(TX, { started_at: "2026-03-01", closed_at: "2026-03-31" });
    expect(scope.inWindow?.emails).toBe(4);
    expect(scope.inWindow?.emailAttachments).toBe(4);
  });

  it("C8: evidence the cloud drops that was never listed is reported and the agent is told", async () => {
    // The cloud loses e-offer's uploaded file before the copy runs: a drop the
    // pre-flight could not have known about.
    const realRpc = fake.rpc.bind(fake);
    fake.rpc = ((fn: string, args: Row) => {
      if (fn === SNAPSHOT_RPC) {
        fake.tables.submission_attachments = fake.tables.submission_attachments.filter(
          (a) => a.local_attachment_id !== "att-offer",
        );
      }
      return realRpc(fn, args);
    }) as typeof fake.rpc;
    const { result } = await submitAcceptingPreflight();
    expect(result.success).toBe(true);
    expect(result.checklistLinksNotAttached).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Checklist evidence was not attached at submission" }),
      expect.objectContaining({ tags: expect.objectContaining({ code: "links_not_attached" }) }),
    );
  });
});
