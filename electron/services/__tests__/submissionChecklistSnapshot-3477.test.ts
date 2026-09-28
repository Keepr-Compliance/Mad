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
jest.mock("electron", () => ({
  app: { getVersion: jest.fn().mockReturnValue("2.38.1") },
  net: { isOnline: () => false },
}));

import { submissionService } from "../submissionService";
import supabaseService from "../supabaseService";
import supabaseStorageService from "../supabaseStorageService";
import databaseService from "../databaseService";
import logService from "../logService";
import { addChecklistLink, selectChecklistTemplate } from "../db/checklistDbService";
import {
  SNAPSHOT_RPC,
  buildChecklistSnapshotPayload,
  type SnapshotChecklistPayload,
} from "../submissionChecklistSnapshot";
import { getChecklistsForTransaction } from "../db/checklistDbService";

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
  rpcCalls: { fn: string; args: Row; parentStatusAtCall: unknown }[] = [];
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
    const matched = () => all().filter((r) => filters.every((f) => f(r)));

    const run = (): { data: unknown; error: PgError | null } => {
      if (mode === "select") {
        const out = matched();
        return { data: limitN === null ? out : out.slice(0, limitN), error: null };
      }
      if (mode === "update") {
        for (const r of matched()) Object.assign(r, payload as Row);
        return { data: matched(), error: null };
      }
      if (mode === "delete") {
        const gone = new Set(matched());
        this.tables[tableName] = all().filter((r) => !gone.has(r));
        return { data: null, error: null };
      }
      const incoming = Array.isArray(payload) ? payload : [payload as Row];
      for (const rec of incoming) all().push({ id: rec.id ?? this.id(tableName), ...rec });
      return { data: incoming, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (p: Row | Row[]) => ((mode = "insert"), (payload = p), builder),
      update: (p: Row) => ((mode = "update"), (payload = p), builder),
      delete: () => ((mode = "delete"), builder),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), builder),
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

  rpc(fn: string, args: Row): Promise<{ data: unknown; error: PgError | null }> {
    const parent = this.tables.transaction_submissions.find((s) => s.id === args.p_submission_id);
    this.rpcCalls.push({ fn, args, parentStatusAtCall: parent?.status });
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
      const clash = [...this.tables.submission_checklists, ...staged.submission_checklists].some(
        (h) => templateId !== null && h.submission_id === sid && h.template_id === templateId,
      );
      if (clash) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
      const headerId = this.id("scl");
      staged.submission_checklists.push({
        id: headerId,
        submission_id: sid,
        template_id: templateId,
        template_name: c.template_name,
        sort_order: c.sort_order ?? 0,
        added_at_review_by: null,
        added_at_review_at: null,
      });
      n.checklists += 1;
      for (const it of (c.items as Row[]) ?? []) {
        if (!this.submitterMayInsert(sid, false)) return Promise.resolve(refuse("submission_checklist_items"));
        const itemId = this.id("sci");
        staged.submission_checklist_items.push({
          id: itemId,
          submission_id: sid,
          submission_checklist_id: headerId,
          title: it.title,
          // BACKLOG-3596 migration 20260928120000 §4: NULLIF(it ->> 'local_item_id', '').
          // A payload without the key (an older desktop) stores NULL.
          local_item_id:
            it.local_item_id == null || it.local_item_id === "" ? null : String(it.local_item_id),
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

  // The real uploader's shape: one result per input, in order, localId = path.
  (supabaseStorageService.uploadAttachments as jest.Mock).mockImplementation(
    async (org: string, sub: string, list: { id: string; localPath: string; filename: string }[]) => ({
      totalCount: list.length,
      successCount: list.length,
      failedCount: 0,
      results: list.map((a, i) => ({
        localId: a.localPath,
        storagePath: `${org}/${sub}/${i}-${a.filename}`,
        success: true,
        mimeType: "application/pdf",
        fileSizeBytes: 2048,
      })),
    }),
  );
});

afterEach(() => {
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
    const result = await submissionService.submitTransaction(TX);

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
    const result = await submissionService.submitTransaction(TX);
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

  it("a FAILED upload ahead of a same-bytes pair does not shift the pairing", async () => {
    // A file whose bytes are gone from disk, attached earlier than the pair, so
    // it is uploaded (and fails) first.
    run(
      `INSERT INTO attachments (id, email_id, filename, mime_type, storage_path, created_at) VALUES
         ('att-gone', 'e-offer', 'gone.pdf', 'application/pdf', '/attachments/gone.pdf', '2026-02-28T10:00:00Z')`,
    );
    const uploaderInputs: string[] = [];
    (supabaseStorageService.uploadAttachments as jest.Mock).mockImplementation(
      async (org: string, sub: string, list: { id: string; localPath: string; filename: string }[]) => {
        uploaderInputs.push(...list.map((a) => a.id));
        const results = list.map((a, i) =>
          a.localPath === "/attachments/gone.pdf"
            ? // Transcribed from the real failure return,
              // electron/services/supabaseStorageService.ts:177-182 (ENOENT branch):
              //   { localId: localPath, storagePath: "", success: false, error }
              //   with error = `File not found: ${absolutePath}`.
              { localId: a.localPath, storagePath: "", success: false, error: `File not found: ${a.localPath}` }
            : {
                localId: a.localPath,
                storagePath: `${org}/${sub}/${i}-${a.filename}`,
                success: true,
                mimeType: "application/pdf",
                fileSizeBytes: 2048,
              },
        );
        const ok = results.filter((r) => r.success).length;
        return { totalCount: list.length, successCount: ok, failedCount: list.length - ok, results };
      },
    );
    await seedChecklists();

    const result = await submissionService.submitTransaction(TX);
    expect(result.success).toBe(true);

    // Premise: the failed upload precedes both halves of the same-bytes pair.
    const gone = uploaderInputs.indexOf("att-gone");
    expect(gone).toBeGreaterThanOrEqual(0);
    expect(gone).toBeLessThan(uploaderInputs.indexOf("att-offer"));
    expect(gone).toBeLessThan(uploaderInputs.indexOf("att-fwd"));

    // The failed upload writes no row; each of the pair keeps its own id.
    expect(fake.tables.submission_attachments.map((a) => a.local_attachment_id).sort()).toEqual(["att-fwd", "att-offer"]);
    expect(memberLocalIds("Signed purchase agreement")).toEqual(["att-offer"]);
    expect(memberLocalIds("Earnest money receipt")).toEqual(["att-fwd"]);
  });

  it("sends exactly the contract's keys, and no reviewer values", async () => {
    await seedChecklists();
    await submissionService.submitTransaction(TX);
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
    const first = await submissionService.submitTransaction(TX);
    expect(first.success).toBe(true);
    fake.tables.transaction_submissions.find((s) => s.id === first.submissionId)!.status = "needs_changes";

    const second = await submissionService.resubmitTransaction(TX);
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

    const result = await submissionService.submitTransaction(TX);

    expect(result.success).toBe(true);
    expect(fake.tables.transaction_submissions.find((s) => s.id === result.submissionId)!.status).toBe("submitted");
    expect(fake.rpcCalls).toHaveLength(1);
    for (const t of ["submission_checklists", "submission_checklist_items", "submission_checklist_links", "submission_checklist_link_members"]) {
      expect([t, fake.tables[t].length]).toEqual([t, 0]);
    }
    const warned = (logService.warn as jest.Mock).mock.calls.find((c) => String(c[0]).includes("Checklists were not copied"));
    expect(warned?.[2]).toMatchObject({ code: "42501" });
  });

  it("no checklist on the transaction: no call at all", async () => {
    const result = await submissionService.submitTransaction(TX);
    expect(result.success).toBe(true);
    expect(fake.rpcCalls).toHaveLength(0);
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
    const result = await submissionService.submitTransaction(TX);
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
    const first = await submissionService.submitTransaction(TX);
    expect(first.success).toBe(true);
    fake.tables.transaction_submissions.find((s) => s.id === first.submissionId)!.status = "needs_changes";
    const second = await submissionService.resubmitTransaction(TX);
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
