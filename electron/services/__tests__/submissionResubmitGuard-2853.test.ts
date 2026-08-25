/**
 * @jest-environment node
 *
 * BACKLOG-2853 — RE-ENTERING SUBMIT ON AN ALREADY-SUBMITTED DEAL AIMED A
 * CASCADING DELETE AT A LIVE SUBMISSION.
 *
 * `submitTransactionInternal` blocked `under_review` / `approved` / `rejected`
 * and let `submitted` fall through to
 *
 *   // Delete old submission (cascades to messages and attachments)
 *   await client.from("transaction_submissions").delete().eq("id", existing.id)
 *
 * with the renderer offering that path an enabled button reading "Submit".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIXTURE PROVENANCE — TRANSCRIBED FROM THE LIVE PRODUCER, NOT INVENTED
 * ─────────────────────────────────────────────────────────────────────────────
 * The fake Supabase client below models the constraints and row-level security
 * of the real `Keepr` project. Every rule it enforces was read out of the live
 * database on 2026-08-25, not off the migration files (which are an incomplete
 * record — `20260414_optimize_auth_uid_initplan.sql` rewrote the policies):
 *
 *   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
 *    WHERE conrelid = 'public.transaction_submissions'::regclass;
 *   → transaction_submissions_org_txn_version_user_key
 *       UNIQUE (organization_id, local_transaction_id, version, submitted_by)
 *   → transaction_submissions_parent_submission_id_fkey
 *       FOREIGN KEY (parent_submission_id)
 *       REFERENCES transaction_submissions(id)          <-- NO ON DELETE CLAUSE
 *   → transaction_submissions_status_check
 *       CHECK (status IN ('uploading','submitted','under_review',
 *                         'needs_changes','resubmitted','approved','rejected'))
 *
 *   SELECT relrowsecurity, relforcerowsecurity FROM pg_class
 *    WHERE relname = 'transaction_submissions';
 *   → true, true          (RLS is ENABLED **and FORCED** on this table)
 *
 *   SELECT policyname, cmd, qual FROM pg_policies
 *    WHERE tablename = 'transaction_submissions' AND cmd = 'DELETE';
 *   → agents_can_delete_stale_uploads
 *       USING ((submitted_by = auth.uid())
 *              AND ((status)::text = 'uploading'::text))
 *     ...and NO other agent-facing DELETE policy. `submission_messages` has no
 *     agent DELETE policy at all; `submission_attachments` has
 *     agents_can_delete_own_attachments, itself limited to parents at
 *     'uploading'.
 *
 *   submission_messages / submission_attachments:
 *       submission_id REFERENCES transaction_submissions(id) ON DELETE CASCADE
 *
 * The desktop app holds the ANON key plus the user's session
 * (electron/services/supabaseService.ts: "never fall back to service_role
 * key"), so those policies govern it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY TWO DISPOSITIONS, AND WHICH ONE THE REVERT CONTROL LIVES IN
 * ─────────────────────────────────────────────────────────────────────────────
 * LIVE_RLS   — the desktop's real authority. The delete of a `submitted` row
 *              matches no row and silently no-ops, so the ORIGINAL SURVIVES
 *              EVEN WITHOUT THE FIX. What the guard changes here is WHEN and
 *              HOW the attempt fails: without it the attachment upload runs to
 *              completion first and the insert then dies on the unique key;
 *              with it the refusal is immediate and names the real reason.
 *              Reverting the guard does NOT turn the survival assertion red in
 *              this disposition — the database is what saves the row, not the
 *              application — and saying so is the point of running it.
 *
 * PERMIT_DELETE — models `service_role_full_access_submissions`
 *              (`USING (auth.role() = 'service_role')`, ALL commands), which is
 *              live on this same table, and any future loosening of the agent
 *              policy. Here the delete lands, the cascade fires, and the
 *              founder's control — revert the `blockedStatuses` addition and
 *              watch the id-SET survival assertion go red — is a real red.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTROLS RUN (results reported on BACKLOG-2853 and in the PR body)
 *   C1  remove "submitted" from blockedStatuses  → PERMIT_DELETE survival RED
 *   C2  remove the `options?.parentSubmissionId` guard around the delete
 *       → PERMIT_DELETE needs_changes RED (parent destroyed, FK violation)
 *   C3  same C1 under LIVE_RLS → survival STAYS GREEN, "blocked" goes red
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * RUNNER:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 electron/services/__tests__/submissionResubmitGuard-2853.test.ts
 */

jest.mock("../supabaseService");
jest.mock("../supabaseStorageService");
jest.mock("../databaseService");
jest.mock("../logService");
jest.mock("../contactsService");
jest.mock("../emailAttachmentService");
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("electron", () => ({
  app: { getVersion: jest.fn().mockReturnValue("2.28.0") },
  net: {},
}));

import { submissionService } from "../submissionService";
import supabaseService from "../supabaseService";
import supabaseStorageService from "../supabaseStorageService";
import databaseService from "../databaseService";
import { getContactNames } from "../contactsService";

// ============================================================================
// FAKE SUPABASE — models the transcribed constraints + RLS above
// ============================================================================

type Row = Record<string, unknown>;
type DeletePolicy = "LIVE_RLS" | "PERMIT_DELETE";

const ORG = "org-2853";
const USER = "user-2853";
const TX = "tx-2853";

/** Statuses the live CHECK constraint permits. */
const STATUS_CHECK = [
  "uploading",
  "submitted",
  "under_review",
  "needs_changes",
  "resubmitted",
  "approved",
  "rejected",
];

class FakeSupabase {
  submissions: Row[] = [];
  messages: Row[] = [];
  attachments: Row[] = [];
  members: Row[] = [{ user_id: USER, organization_id: ORG }];
  errorLogs: Row[] = [];
  deletePolicy: DeletePolicy = "LIVE_RLS";

  private table(name: string): Row[] {
    switch (name) {
      case "transaction_submissions":
        return this.submissions;
      case "submission_messages":
        return this.messages;
      case "submission_attachments":
        return this.attachments;
      case "organization_members":
        return this.members;
      case "error_logs":
        return this.errorLogs;
      default:
        throw new Error(`FakeSupabase: unknown table ${name}`);
    }
  }

  /**
   * RLS DELETE, transcribed. `agents_can_delete_stale_uploads` permits a
   * submissions row only at status 'uploading' and only the submitter's own;
   * `submission_messages` has NO agent delete policy; attachments inherit the
   * 'uploading' parent restriction. Rows that fail the policy are simply not
   * deleted and PostgREST still answers 204 — which is why the production code
   * never noticed (it does not read the delete result either way).
   */
  private mayDelete(tableName: string, row: Row): boolean {
    if (this.deletePolicy === "PERMIT_DELETE") return true;
    if (tableName === "transaction_submissions") {
      return row.submitted_by === USER && row.status === "uploading";
    }
    if (tableName === "submission_messages") return false;
    if (tableName === "submission_attachments") {
      const parent = this.submissions.find((s) => s.id === row.submission_id);
      return !!parent && parent.submitted_by === USER && parent.status === "uploading";
    }
    return true;
  }

  /** ON DELETE CASCADE from submission_id, transcribed from the FKs. */
  private cascade(submissionIds: unknown[]): void {
    this.messages = this.messages.filter((m) => !submissionIds.includes(m.submission_id));
    this.attachments = this.attachments.filter(
      (a) => !submissionIds.includes(a.submission_id)
    );
  }

  from(tableName: string) {
    const rows = () => this.table(tableName);
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;

    const matched = () => rows().filter((r) => filters.every((f) => f(r)));

    const runWrite = (): { data: Row[] | null; error: { message: string; code?: string } | null } => {
      if (mode === "delete") {
        const target = matched().filter((r) => this.mayDelete(tableName, r));
        const ids = target.map((r) => r.id);
        const keep = rows().filter((r) => !target.includes(r));
        if (tableName === "transaction_submissions") {
          this.cascade(ids);
          this.submissions = keep;
        } else if (tableName === "submission_messages") {
          this.messages = keep;
        } else if (tableName === "submission_attachments") {
          this.attachments = keep;
        }
        return { data: target, error: null };
      }

      if (mode === "update") {
        for (const r of matched()) Object.assign(r, payload as Row);
        return { data: matched(), error: null };
      }

      // insert
      const incoming = Array.isArray(payload) ? payload : [payload as Row];
      for (const rec of incoming) {
        if (tableName === "transaction_submissions") {
          if (!STATUS_CHECK.includes(String(rec.status))) {
            return {
              data: null,
              error: {
                code: "23514",
                message: `new row for relation "transaction_submissions" violates check constraint "transaction_submissions_status_check"`,
              },
            };
          }
          if (rec.parent_submission_id != null) {
            const parent = this.submissions.find((s) => s.id === rec.parent_submission_id);
            if (!parent) {
              return {
                data: null,
                error: {
                  code: "23503",
                  message: `insert or update on table "transaction_submissions" violates foreign key constraint "transaction_submissions_parent_submission_id_fkey"`,
                },
              };
            }
          }
          const clash = this.submissions.find(
            (s) =>
              s.organization_id === rec.organization_id &&
              s.local_transaction_id === rec.local_transaction_id &&
              (s.version ?? 1) === (rec.version ?? 1) &&
              s.submitted_by === rec.submitted_by
          );
          if (clash) {
            return {
              data: null,
              error: {
                code: "23505",
                message: `duplicate key value violates unique constraint "transaction_submissions_org_txn_version_user_key"`,
              },
            };
          }
        }
        rows().push({ ...rec });
      }
      return { data: incoming, error: null };
    };

    const builder: Record<string, unknown> = {
      select(_cols?: string) {
        mode = "select";
        return builder;
      },
      insert(records: Row | Row[]) {
        mode = "insert";
        payload = records;
        return builder;
      },
      update(patch: Row) {
        mode = "update";
        payload = patch;
        return builder;
      },
      delete() {
        mode = "delete";
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      maybeSingle() {
        const found = matched();
        if (found.length > 1) {
          // PostgREST: "JSON object requested, multiple (or no) rows returned"
          return Promise.resolve({ data: null, error: { code: "PGRST116", message: "multiple rows" } });
        }
        return Promise.resolve({ data: found[0] ?? null, error: null });
      },
      single() {
        const found = matched();
        if (found.length !== 1) {
          return Promise.resolve({ data: null, error: { code: "PGRST116", message: "no rows" } });
        }
        return Promise.resolve({ data: found[0], error: null });
      },
      then(resolve: (v: unknown) => unknown) {
        const result = mode === "select" ? { data: matched(), error: null } : runWrite();
        return Promise.resolve(result).then(resolve);
      },
    };
    return builder;
  }
}

let fake: FakeSupabase;

/**
 * The LOCAL sqlite row, which is a second producer this path reads.
 * `updateLocalSubmissionStatus` writes `submission_id` on every successful
 * submit, so a deal that has been submitted before carries it — and
 * `resubmitTransaction` refuses outright without it ("Transaction has not been
 * submitted before"). Seeding a cloud submission therefore has to set it too,
 * or the fixture describes a machine state the app cannot produce: a cloud
 * submission with no local pointer to it.
 */
let localTransaction: Row;

/** Seed a submission plus the messages and attachments that cascade from it. */
function seedSubmission(status: string, version = 1): { id: string; messageIds: string[]; attachmentIds: string[] } {
  const id = `sub-${status}-v${version}`;
  fake.submissions.push({
    id,
    organization_id: ORG,
    submitted_by: USER,
    local_transaction_id: TX,
    property_address: "18 Bellweather Lane",
    status,
    version,
    parent_submission_id: null,
  });
  const messageIds = [`msg-${id}-1`, `msg-${id}-2`];
  const attachmentIds = [`att-${id}-1`];
  for (const mid of messageIds) fake.messages.push({ id: mid, submission_id: id });
  for (const aid of attachmentIds)
    fake.attachments.push({ id: aid, submission_id: id, filename: "offer.pdf" });
  localTransaction.submission_id = id;
  localTransaction.submission_status = status;
  return { id, messageIds, attachmentIds };
}

const idSet = (rows: Row[]): Set<unknown> => new Set(rows.map((r) => r.id));

beforeEach(() => {
  jest.clearAllMocks();
  fake = new FakeSupabase();

  (supabaseService.getClient as jest.Mock).mockImplementation(() => fake);
  (supabaseService.getAuthSession as jest.Mock).mockResolvedValue({
    userId: USER,
    email: "agent@example.com",
    accessToken: "token",
  });

  localTransaction = {
    id: TX,
    user_id: USER,
    property_address: "18 Bellweather Lane",
    transaction_type: "purchase",
    started_at: null,
    closed_at: null,
    submission_id: null,
    submission_status: "not_submitted",
  };
  (databaseService.getTransactionById as jest.Mock).mockImplementation(async () => ({
    ...localTransaction,
  }));
  (databaseService.getTransactionMessages as jest.Mock).mockReturnValue([]);
  (databaseService.getTransactionEmails as jest.Mock).mockReturnValue([]);
  // ONE local attachment, so "the upload stage runs" is an observable event.
  (databaseService.getTransactionAttachments as jest.Mock).mockReturnValue([
    {
      id: "local-att-1",
      message_id: "local-msg-1",
      filename: "inspection.pdf",
      storage_path: "/local/inspection.pdf",
      created_at: "2026-08-01T10:00:00Z",
    },
  ]);
  (databaseService.updateTransaction as jest.Mock).mockResolvedValue(undefined);

  (getContactNames as jest.Mock).mockResolvedValue({
    status: { success: true },
    contactMap: {},
  });

  (supabaseStorageService.uploadAttachments as jest.Mock).mockResolvedValue({
    results: [
      {
        localId: "/local/inspection.pdf",
        storagePath: `${ORG}/new/inspection.pdf`,
        success: true,
        mimeType: "application/pdf",
        fileSizeBytes: 1024,
      },
    ],
    successCount: 1,
    failedCount: 0,
  });
});

// ============================================================================
// LIVE_RLS — the desktop's real authority
// ============================================================================

describe("BACKLOG-2853 · LIVE_RLS disposition (anon key + user session, the desktop's real authority)", () => {
  test("a submit at status 'submitted' is REFUSED, and the existing submission + its messages + its attachments survive BY ID SET", async () => {
    const seeded = seedSubmission("submitted");
    const beforeSubs = idSet(fake.submissions);
    const beforeMsgs = idSet(fake.messages);
    const beforeAtts = idSet(fake.attachments);

    const result = await submissionService.submitTransaction(TX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already been submitted/i);

    // Identity, not count: a delete-then-insert keeps the count at one.
    expect(idSet(fake.submissions)).toEqual(beforeSubs);
    expect(idSet(fake.submissions)).toEqual(new Set([seeded.id]));
    expect(idSet(fake.messages)).toEqual(beforeMsgs);
    expect(idSet(fake.messages)).toEqual(new Set(seeded.messageIds));
    expect(idSet(fake.attachments)).toEqual(beforeAtts);
    expect(idSet(fake.attachments)).toEqual(new Set(seeded.attachmentIds));

    // The refusal happens BEFORE the longest stage. Without the guard this
    // upload runs to completion and only then does the insert die on the
    // unique key, leaving files in Storage under an id that never exists.
    expect(supabaseStorageService.uploadAttachments).not.toHaveBeenCalled();
  });

  test("the blocked SET, derived by executing every status rather than by reading the list", async () => {
    const blocked: string[] = [];
    const allowed: string[] = [];

    for (const status of ["submitted", "under_review", "needs_changes", "resubmitted", "approved", "rejected"]) {
      fake = new FakeSupabase();
      (supabaseService.getClient as jest.Mock).mockImplementation(() => fake);
      seedSubmission(status);
      const result = await submissionService.submitTransaction(TX);
      const refused = !result.success && /Cannot resubmit|already been (submitted|approved)|has been rejected/i.test(result.error ?? "");
      (refused ? blocked : allowed).push(status);
    }

    expect(new Set(blocked)).toEqual(
      new Set(["submitted", "under_review", "approved", "rejected"])
    );
    // `resubmitted` is knowingly still permitted — raised as a question on
    // BACKLOG-2853, not taken silently. This pins it so the answer, whichever
    // way it goes, has to come through this expectation.
    expect(new Set(allowed)).toEqual(new Set(["needs_changes", "resubmitted"]));
  });

  test("'needs_changes' still resubmits, reaches the VERSIONING path, and the previous version survives by id", async () => {
    const seeded = seedSubmission("needs_changes", 1);

    const result = await submissionService.resubmitTransaction(TX);

    expect(result.success).toBe(true);

    // The version is asserted as a NUMBER, not as "it succeeded".
    const fresh = fake.submissions.find((s) => s.id === result.submissionId);
    expect(fresh?.version).toBe(2);
    expect(fresh?.status).toBe("resubmitted");
    expect(fresh?.parent_submission_id).toBe(seeded.id);

    // The row it versioned FROM is still there, with its cascaded children.
    expect(fake.submissions.map((s) => s.id)).toContain(seeded.id);
    expect(idSet(fake.messages).has(seeded.messageIds[0])).toBe(true);
    expect(idSet(fake.attachments)).toEqual(
      new Set([...seeded.attachmentIds, ...fake.attachments.filter((a) => a.submission_id === result.submissionId).map((a) => a.id)])
    );
  });

  test("'under_review', 'approved' and 'rejected' remain blocked — regression guard on the pre-existing list", async () => {
    for (const status of ["under_review", "approved", "rejected"]) {
      fake = new FakeSupabase();
      (supabaseService.getClient as jest.Mock).mockImplementation(() => fake);
      const seeded = seedSubmission(status);

      const result = await submissionService.submitTransaction(TX);

      expect(result.success).toBe(false);
      expect(idSet(fake.submissions)).toEqual(new Set([seeded.id]));
      expect(idSet(fake.messages)).toEqual(new Set(seeded.messageIds));
    }
  });
});

// ============================================================================
// PERMIT_DELETE — service_role, or a loosened agent policy
// ============================================================================

describe("BACKLOG-2853 · PERMIT_DELETE disposition (service_role_full_access_submissions, or policy drift)", () => {
  beforeEach(() => {
    fake.deletePolicy = "PERMIT_DELETE";
  });

  test("THE CONTROL: a submit at 'submitted' is refused before the delete, so the row and its cascade survive BY ID SET", async () => {
    const seeded = seedSubmission("submitted");

    const result = await submissionService.submitTransaction(TX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already been submitted/i);

    // With "submitted" removed from blockedStatuses these three go RED here:
    // the delete lands, the FK cascade takes the messages and the attachments
    // with it, and the replacement is a different id.
    expect(idSet(fake.submissions)).toEqual(new Set([seeded.id]));
    expect(idSet(fake.messages)).toEqual(new Set(seeded.messageIds));
    expect(idSet(fake.attachments)).toEqual(new Set(seeded.attachmentIds));
  });

  test("a resubmit from 'needs_changes' does NOT delete its own parent — the row `parent_submission_id` points at is still there", async () => {
    const seeded = seedSubmission("needs_changes", 1);

    const result = await submissionService.resubmitTransaction(TX);

    expect(result.success).toBe(true);

    // Without the `options?.parentSubmissionId` guard this is where a delete
    // that is PERMITTED destroys the parent and the versioned insert then
    // violates transaction_submissions_parent_submission_id_fkey — the
    // original lost AND the replacement rejected.
    expect(fake.submissions.map((s) => s.id)).toContain(seeded.id);
    expect(idSet(fake.messages).has(seeded.messageIds[0])).toBe(true);

    const fresh = fake.submissions.find((s) => s.id === result.submissionId);
    expect(fresh?.version).toBe(2);
    expect(fresh?.parent_submission_id).toBe(seeded.id);
  });
});
