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
 *
 * BACKLOG-2867 EXTENDED THIS SUITE. The lookup ahead of the guard took no
 * ordering and dropped its error, so on a deal with TWO versions it returned
 * PGRST116, `existingSubmission` was null, and the guard above was skipped
 * entirely — inert on exactly the deals furthest along. Three more controls,
 * each isolating one half of that fix plus the regression the fix creates:
 *   M1  revert the ordering only (`.order().limit()` off, error handling kept)
 *       → "the CURRENT version decides" RED on the NAMED ID and the MESSAGE.
 *       It stays green on "was the submit refused", because the fail-closed
 *       branch refuses too — which is why those assertions exist.
 *   M2  revert the error handling only (ordering kept)
 *       → "FAIL CLOSED" RED: the submit succeeds and writes a row.
 *   M3  revert the `existingVersion !== pendingVersion` condition on the
 *       delete → PERMIT_DELETE "does NOT delete the current version" RED.
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
import { BLOCKED_SUBMISSION_MESSAGES } from "../submissionStatusMessages";

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

  /**
   * BACKLOG-2868 — every `.maybeSingle()` this client served, and how many rows
   * it matched. `matched > 1` is the PGRST116 branch: PostgREST returns no data
   * and an error, and `submitTransactionInternal` does not destructure that
   * error, so `existingSubmission` becomes null and the status guard behind
   * `if (existingSubmission)` is skipped without anything logging that it was.
   * This is the only way to SEE that from outside. See BACKLOG-2867.
   */
  maybeSingleLookups: {
    table: string;
    /** Rows the FILTERS matched, BEFORE any `.limit()`. */
    matched: number;
    /** The row the lookup actually handed back, by id. */
    returnedIds: unknown[];
  }[] = [];

  /**
   * BACKLOG-2867 — make the single-row lookup on `transaction_submissions`
   * answer with an error envelope instead of data.
   *
   * Shape is PostgREST's, the same one this fake already returns for PGRST116
   * and for the unique-key violation. `PGRST301 / "JWT expired"` is a real
   * failure of this exact call in this app: the desktop holds the anon key
   * plus the user session, and the broker portal has a hand-written branch for
   * that code (`broker-portal/components/submission/ReviewActions.tsx`).
   *
   * A dropped error is the second half of BACKLOG-2867 and cannot be observed
   * any other way: with the error discarded, a failed check and a clean deal
   * are the same value — `data: null`.
   */
  lookupError: { code: string; message: string } | null = null;

  /** Monotonic, so `created_at` ordering is deterministic in the fake. */
  private clock = 0;
  nextCreatedAt(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 7, 1, 0, 0, this.clock)).toISOString();
  }

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
    const orders: Array<{ col: string; ascending: boolean }> = [];
    let limitN: number | null = null;
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;

    const matched = () => rows().filter((r) => filters.every((f) => f(r)));

    /**
     * BACKLOG-2867 — WHERE, then ORDER BY, then LIMIT, in that order, because
     * that is the order the database applies them and the whole fix is that
     * the lookup must name ONE row deterministically. A fake that limited
     * before ordering would green-light a query that picks an arbitrary row.
     *
     * Nullish sorts LOWEST, matching Postgres `ORDER BY ... DESC` with the
     * default NULLS FIRST/LAST only in the sense that matters here: a row with
     * no `created_at` never outranks one that has it. Every row this fake
     * stores gets a `created_at` on insert (see the DEFAULT now() note below),
     * so this is a guard, not a code path the suite depends on.
     */
    const projected = (): Row[] => {
      const out = [...matched()];
      for (const o of [...orders].reverse()) {
        out.sort((a, b) => {
          const av = a[o.col];
          const bv = b[o.col];
          if (av === bv) return 0;
          if (av === null || av === undefined) return o.ascending ? -1 : 1;
          if (bv === null || bv === undefined) return o.ascending ? 1 : -1;
          const cmp = (av as number | string) > (bv as number | string) ? 1 : -1;
          return o.ascending ? cmp : -cmp;
        });
      }
      return limitN === null ? out : out.slice(0, limitN);
    };

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
        // `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` on all three tables:
        // submission_messages / submission_attachments records are inserted
        // WITHOUT an id and the database supplies one. Without this the fake
        // stored `id: undefined` and an id-SET diff read as `undefined`
        // instead of naming the row that replaced the original.
        // `id UUID DEFAULT gen_random_uuid()` and `created_at timestamptz
        // DEFAULT now()` — `mapToSubmission` writes neither, so the database
        // supplies both. BACKLOG-2867 orders on `created_at`, so a fake that
        // left it undefined would be describing rows the table cannot hold.
        rows().push({
          id: rec.id ?? `gen-${Math.random().toString(16).slice(2)}`,
          created_at: rec.created_at ?? this.nextCreatedAt(),
          ...rec,
        });
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
      order(col: string, opts?: { ascending?: boolean }) {
        orders.push({ col, ascending: opts?.ascending !== false });
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      maybeSingle: () => {
        const preLimit = matched();
        const found = projected();
        /**
         * BACKLOG-2868 — RECORD EVERY SINGLE-ROW LOOKUP, SO "THE GUARD WAS
         * NEVER CONSULTED" CAN BE OBSERVED RATHER THAN INFERRED.
         *
         * Needed because the RESULT of `submitTransaction` cannot separate the
         * two cases. Measured: a `needs_changes` deal (one row — the guard runs
         * and the list declines to block it) and a `resubmitted` deal (two rows
         * — the guard is skipped entirely) BOTH end in the identical late
         * duplicate-key error after a full attachment upload. Same outcome,
         * different mechanism. A bucket derived from the outcome would be
         * reporting a mechanism it never measured, which is the failure this
         * whole correction is about. This records the branch actually taken.
         */
        this.maybeSingleLookups.push({
          table: tableName,
          matched: preLimit.length,
          returnedIds: found.map((r) => r.id),
        });
        if (tableName === "transaction_submissions" && this.lookupError) {
          return Promise.resolve({ data: null, error: this.lookupError });
        }
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
        const result =
          mode === "select" ? { data: projected(), error: null } : runWrite();
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
    created_at: fake.nextCreatedAt(),
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

/** All three tables at once, sorted, so one diff shows a whole cascade. */
const survivors = (): Record<string, unknown[]> => ({
  submissions: fake.submissions.map((r) => r.id).sort(),
  messages: fake.messages.map((r) => r.id).sort(),
  attachments: fake.attachments.map((r) => r.id).sort(),
});

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
  /**
   * BACKLOG-2868 — THE LOCAL ROW IS NOW A REAL DOWNSTREAM OF THE PRODUCER.
   *
   * This used to be `mockResolvedValue(undefined)`, so a successful submit left
   * `localTransaction` describing the state BEFORE it ran. That is fine while
   * every fixture is hand-seeded, and wrong the moment a test wants to reach a
   * machine state by EXECUTING the app — `updateLocalSubmissionStatus` is how
   * production writes `submission_status` and `submission_id` back, and
   * `resubmitTransaction` refuses outright without the latter. Applying the
   * update here is what lets `arriveAtResubmitted()` below produce a genuine
   * two-row deal instead of a seeded impression of one.
   */
  (databaseService.updateTransaction as jest.Mock).mockImplementation(
    async (_id: string, updates: Record<string, unknown>) => {
      Object.assign(localTransaction, updates);
      return undefined;
    }
  );

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

/**
 * BACKLOG-2868 — REACH `resubmitted` BY RUNNING THE PRODUCER, NOT BY SEEDING.
 *
 * WHAT WAS WRONG. This suite reached `resubmitted` via `seedSubmission(status)`,
 * which defaults to `version = 1`. Traced through the code that emits it:
 *
 *   submissionService.ts — `finalStatus = options?.version ? "resubmitted" : "submitted"`
 *   submissionService.ts — `newVersion = (existingSubmission?.version || 1) + 1`
 *
 * `options.version` is set ONLY by `resubmitTransaction`, and it is always
 * `current + 1`, i.e. always >= 2. So a row at status `resubmitted` ALWAYS
 * carries version >= 2, and — since BACKLOG-2853 stopped the versioning path
 * deleting its own parent — always has a retained version-1 sibling. A
 * version-1 `resubmitted` row is a state no code path in this app can emit.
 *
 * That is the first failure shape in CLAUDE.md: a fixture standing in for a
 * producer rather than transcribed from it. It reached the right verdict
 * ("`resubmitted` is not blocked") through a mechanism that does not exist —
 * it demonstrated the status guard declining to list a status, when in
 * reality the guard is never consulted at all. Green carrying no information.
 *
 * WHY NOT JUST SEED (v1 parent + v2 `resubmitted`). Because that swaps one
 * invention for a better-informed invention, and the version arithmetic and
 * the parent-retention are precisely the parts under test. Running
 * `resubmitTransaction` makes the fixture literally the producer's own
 * output: whatever the app really writes is what the guard is then asked
 * about. If the version rule ever changes, this helper changes with it for
 * free, and a hand-seeded pair would not.
 */
async function arriveAtResubmitted(): Promise<{
  parentId: string;
  resubmittedId: string;
}> {
  // A broker-returned deal — the only legitimate way into a resubmit.
  const parent = seedSubmission("needs_changes", 1);

  const produced = await submissionService.resubmitTransaction(TX);
  expect(produced.success).toBe(true);

  // The producer's own output, asserted rather than assumed: the app is now
  // in the state this test needs, and says so.
  const fresh = fake.submissions.find((s) => s.id === produced.submissionId);
  expect(fresh?.status).toBe("resubmitted");
  expect(fresh?.version).toBe(2);
  expect(localTransaction.submission_status).toBe("resubmitted");
  expect(fake.submissions).toHaveLength(2);

  // Narrowed, not asserted away: `submissionId` is `string | null` on the
  // producer's result type, and a null here would mean the resubmit did not
  // actually create a row — which every caller below assumes it did.
  const resubmittedId = produced.submissionId;
  if (typeof resubmittedId !== "string") {
    throw new Error(
      `resubmitTransaction returned no submissionId: ${JSON.stringify(produced)}`
    );
  }

  return { parentId: parent.id, resubmittedId };
}

/**
 * A fresh store plus a deal that has never been submitted — the state the
 * outer `beforeEach` leaves behind. Used where one test walks several
 * independent fixtures.
 */
function resetFake(): void {
  fake = new FakeSupabase();
  (supabaseService.getClient as jest.Mock).mockImplementation(() => fake);
  localTransaction.submission_id = null;
  localTransaction.submission_status = "not_submitted";
  (supabaseStorageService.uploadAttachments as jest.Mock).mockClear();
}

/**
 * The BROKER's write, transcribed from the portal that performs it —
 * `broker-portal/components/submission/ReviewActions.tsx` (approve / reject /
 * changes) and `broker-portal/app/dashboard/submissions/[id]/page.tsx`, which
 * flips `submitted` or `resubmitted` to `under_review` the moment a broker
 * opens the submission. Both write `transaction_submissions.status` by id;
 * `submissionSyncService` then mirrors it onto the local row.
 *
 * BACKLOG-2867 needs this because the state it is about is not one the desktop
 * can reach alone: a deal whose CURRENT version sits at a blocked status
 * exists only after a broker has touched it. Seeding that status directly
 * would be inventing the producer instead of running it.
 */
function brokerSetsStatus(submissionId: string, status: string): void {
  const row = fake.submissions.find((r) => r.id === submissionId);
  if (!row) {
    throw new Error(`brokerSetsStatus: no submission ${submissionId}`);
  }
  if (!STATUS_CHECK.includes(status)) {
    throw new Error(`brokerSetsStatus: ${status} violates the CHECK constraint`);
  }
  row.status = status;
  row.reviewed_by = "broker-2867";
  row.reviewed_at = new Date().toISOString();
  if (localTransaction.submission_id === submissionId) {
    localTransaction.submission_status = status;
  }
}

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

    // SURVIVAL IS ASSERTED FIRST, ON PURPOSE. It is the load-bearing claim, so
    // it must be the assertion a revert turns red — not a message string that
    // happens to be checked earlier and fails for its own reasons.
    // Identity, not count: a delete-then-insert keeps the count at one.
    expect(idSet(fake.submissions)).toEqual(beforeSubs);
    expect(idSet(fake.submissions)).toEqual(new Set([seeded.id]));
    expect(idSet(fake.messages)).toEqual(beforeMsgs);
    expect(idSet(fake.messages)).toEqual(new Set(seeded.messageIds));
    expect(idSet(fake.attachments)).toEqual(beforeAtts);
    expect(idSet(fake.attachments)).toEqual(new Set(seeded.attachmentIds));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already been submitted/i);

    // The refusal happens BEFORE the longest stage. Without the guard this
    // upload runs to completion and only then does the insert die on the
    // unique key, leaving files in Storage under an id that never exists.
    expect(supabaseStorageService.uploadAttachments).not.toHaveBeenCalled();
  });

  test("a 'resubmitted' row can only exist at version >= 2 — the fixture the app can actually produce", async () => {
    const { parentId, resubmittedId } = await arriveAtResubmitted();

    const versions = fake.submissions
      .map((r) => r.version as number)
      .sort((a, b) => a - b);
    expect(versions).toEqual([1, 2]);

    // Version 1 is the retained parent, and it is NOT the resubmitted row.
    const v1 = fake.submissions.find((r) => r.version === 1);
    const v2 = fake.submissions.find((r) => r.version === 2);
    expect(v1?.id).toBe(parentId);
    expect(v2?.id).toBe(resubmittedId);
    expect(v2?.status).toBe("resubmitted");
    expect(v2?.parent_submission_id).toBe(parentId);

    // The claim stated as the invariant it is: nothing in this store is a
    // version-1 `resubmitted` row, which is what the old fixture asserted on.
    expect(
      fake.submissions.filter((r) => r.status === "resubmitted" && r.version === 1)
    ).toEqual([]);
  });

  /**
   * BACKLOG-2867 — WHAT THIS TEST USED TO SAY, AND WHY THE WORDING CHANGED.
   *
   * Until BACKLOG-2867 this test was called "at 'resubmitted' the guard is
   * never REACHED", and that was accurate: the lookup ahead of the guard was
   * `.eq(org).eq(local_transaction_id).maybeSingle()` with no ordering and no
   * limit, its `error` was never destructured, two rows produced PGRST116,
   * `existingSubmission` came back null, and `if (existingSubmission)` was
   * false. The guard did not decline to block `resubmitted`; it never ran.
   *
   * The lookup now orders by version and takes one row, so the guard IS
   * reached on a two-row deal — and `resubmitted` is genuinely not on the
   * list, which is the mechanism this test now measures. It also pins the two
   * things that must NOT have changed with it:
   *
   *   - the delete is SKIPPED, because the current row is version 2 and this
   *     attempt inserts version 1. Deleting it would clear nothing and would
   *     destroy the live submission (see the PERMIT_DELETE twin, which is
   *     where that is a real red).
   *   - the outcome is unchanged from before the fix: the upload still runs
   *     and the insert still dies on the unique key. Closing THAT window is
   *     BACKLOG-2790's reorder, not this change, and pretending otherwise
   *     here would be claiming a fix nobody wrote.
   */
  test("at 'resubmitted' the guard is now REACHED, declines, and skips the delete (BACKLOG-2867)", async () => {
    const { parentId, resubmittedId } = await arriveAtResubmitted();

    const before = survivors();
    (supabaseStorageService.uploadAttachments as jest.Mock).mockClear();
    fake.maybeSingleLookups = [];

    const result = await submissionService.submitTransaction(TX);

    // THE MECHANISM, ASSERTED FIRST: two rows matched the filters, and the
    // lookup handed back exactly ONE of them — version 2, by id.
    const guardLookup = fake.maybeSingleLookups.find(
      (l) => l.table === "transaction_submissions"
    );
    expect(guardLookup).toBeDefined();
    expect(guardLookup?.matched).toBe(2);
    expect(guardLookup?.returnedIds).toEqual([resubmittedId]);

    expect(result.success).toBe(false);

    // Not a guard refusal — `resubmitted` is not on the list.
    expect(result.error).not.toMatch(/Cannot resubmit/i);
    expect(result.error).not.toMatch(/already been (submitted|approved)/i);
    expect(result.error).not.toMatch(/has been rejected/i);
    expect(result.error).not.toMatch(/Could not check whether/i);

    // What it IS, unchanged from before the fix: the late duplicate-key
    // failure, after the longest stage.
    expect(supabaseStorageService.uploadAttachments).toHaveBeenCalled();
    expect(result.error).toMatch(/duplicate key/i);
    expect(result.error).toMatch(
      /transaction_submissions_org_txn_version_user_key/
    );

    // BOTH rows survive, by id, across all three tables — including the
    // version-2 row the fixed lookup just named and the delete declined to
    // touch. Under LIVE_RLS the database would have stopped that delete
    // anyway; the PERMIT_DELETE twin is where this assertion has teeth.
    expect(survivors()).toEqual(before);
    expect(fake.submissions.map((r) => r.id).sort()).toEqual(
      [parentId, resubmittedId].sort()
    );
  });

  test("the blocked SET, derived by executing every status rather than by reading the list", async () => {
    /**
     * BACKLOG-2868 — CLASSIFIED BY "DID THE UPLOAD RUN", NOT BY "DID IT
     * SUCCEED", AND THE CHANGE CAME FROM A MEASUREMENT THAT CONTRADICTED THE
     * FIRST DRAFT OF THIS TEST.
     *
     * BACKLOG-2853 had two buckets, `blocked` and `allowed`, where `allowed`
     * meant only "not refused by the guard". Measured across all six statuses,
     * that name was wrong: a plain `submitTransaction` on a `needs_changes`
     * deal does NOT succeed under the desktop's real authority. It runs the
     * full attachment upload and then dies on the unique key — because the
     * delete of its existing row no-ops under LIVE_RLS and the re-insert
     * collides at version 1. Nothing in the old suite said so, because "not
     * refused" was being read as "allowed".
     *
     * (No user reaches that: `TransactionDetails` and `useBulkSubmit` both
     * route `needs_changes` to `resubmitTransaction`, which versions properly
     * and is covered by the next test. It is the classification that was
     * misleading, not the product.)
     *
     * So the bucket boundary is the observable the guard actually exists to
     * change: WHETHER EXECUTION REACHED THE UPLOAD. That is the difference
     * between an immediate, accurate refusal and a multi-minute walk to a
     * duplicate-key error with files already pushed to Storage.
     */
    const refusedBeforeUpload: string[] = [];
    const fellThroughToUpload: string[] = [];
    /** status → how many rows the guard's own lookup could name. */
    const lookupMatched: Record<string, number> = {};

    for (const status of [
      "submitted",
      "under_review",
      "needs_changes",
      "resubmitted",
      "approved",
      "rejected",
    ]) {
      fake = new FakeSupabase();
      (supabaseService.getClient as jest.Mock).mockImplementation(() => fake);
      localTransaction.submission_id = null;
      localTransaction.submission_status = "not_submitted";

      if (status === "resubmitted") {
        // Produced by running the app, not seeded. See `arriveAtResubmitted`.
        await arriveAtResubmitted();
      } else {
        seedSubmission(status);
      }

      (supabaseStorageService.uploadAttachments as jest.Mock).mockClear();
      fake.maybeSingleLookups = [];

      const result = await submissionService.submitTransaction(TX);

      const uploaded = (supabaseStorageService.uploadAttachments as jest.Mock)
        .mock.calls.length;
      (uploaded === 0 ? refusedBeforeUpload : fellThroughToUpload).push(status);

      const guardLookup = fake.maybeSingleLookups.find(
        (l) => l.table === "transaction_submissions"
      );
      lookupMatched[status] = guardLookup?.matched ?? -1;
      // Post-limit: whatever the filters matched, the lookup must name ONE row.
      expect(guardLookup?.returnedIds).toHaveLength(1);

      // Every refusal is a REAL refusal, named by the message the service
      // throws — not merely an absence of an upload.
      if (uploaded === 0) {
        expect(result.error).toMatch(
          /Cannot resubmit|already been (submitted|approved)|has been rejected/i
        );
      }
    }

    expect(new Set(refusedBeforeUpload)).toEqual(
      new Set(["submitted", "under_review", "approved", "rejected"])
    );
    expect(new Set(fellThroughToUpload)).toEqual(
      new Set(["needs_changes", "resubmitted"])
    );

    /**
     * AND THE TWO IN THAT SECOND BUCKET ARE THERE FOR DIFFERENT REASONS —
     * which the outcome alone cannot show, since both end in the same
     * duplicate-key error.
     *
     * `needs_changes`: the lookup named ONE row, so the guard ran and the list
     * legitimately declined to block it.
     *
     * `resubmitted`: the lookup's FILTERS match TWO rows. Before BACKLOG-2867
     * that meant PGRST116, a dropped error, and a guard that was never
     * consulted; since BACKLOG-2867 the lookup orders by version and takes
     * one, so the guard runs against version 2 and declines it on the same
     * terms as `needs_changes` — the version-mismatch branch then skips the
     * delete. Same bucket, and now for a reason that is written down.
     *
     * `lookupMatched` stays the PRE-limit count on purpose: it is the number
     * that says "this deal has been round-tripped", and flipping it to 1 to
     * match the new `.limit(1)` would have quietly erased the distinction
     * this test exists to draw. `returnedIds` carries the post-limit answer.
     *
     * Whether "resubmitted" belongs on `BLOCKED_SUBMISSION_STATUSES` is now a
     * live question rather than a moot one — adding it would change behaviour
     * where before it could not. BACKLOG-2867 deliberately does not take that
     * decision; see `submissionStatusMessages.ts`.
     */
    expect(lookupMatched.needs_changes).toBe(1);
    expect(lookupMatched.resubmitted).toBe(2);
    for (const status of ["submitted", "under_review", "approved", "rejected"]) {
      expect(lookupMatched[status]).toBe(1);
    }
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
    expect(fake.submissions.map((r) => r.id)).toContain(seeded.id);
    expect(fake.messages.map((r) => r.id)).toEqual(
      expect.arrayContaining(seeded.messageIds)
    );
    expect(fake.attachments.map((r) => r.id)).toEqual(
      expect.arrayContaining(seeded.attachmentIds)
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
// BACKLOG-2867 — the lookup must name ONE row, and its error must be read
// ============================================================================

describe("BACKLOG-2867 · once a deal has two submission versions", () => {
  /**
   * THE HEADLINE. Run against the unfixed service this test is red three
   * times over: the lookup hands back BOTH rows, the refusal message is a
   * duplicate-key error instead of the guard's, and the attachment upload has
   * already run by the time it fails.
   *
   * FIXTURE PROVENANCE. The pair is the shape measured live on the Keepr
   * project on 2026-08-25 while reviewing PR #2394 — one transaction holding
   * two rows, versions [1, 2], statuses [rejected, under_review]. (The
   * identifiers stay off a public repo; they are on BACKLOG-2867, with the
   * `GROUP BY organization_id, local_transaction_id HAVING count(*) > 1`
   * that found them.)
   *
   * It is reached the way the app reaches it, not seeded: the desktop
   * produces version 2 through `resubmitTransaction`, then the broker portal
   * sets the statuses (`ReviewActions.tsx` for `rejected`, the submission
   * detail page for `under_review`). A `SELECT version, status ... GROUP BY`
   * over the whole live table on the same date returns no `submitted` row
   * above version 1, which is why the current version here is `under_review`
   * and not the `submitted` the item's first draft of this control named:
   * nothing in either codebase writes `submitted` to a version-2 row.
   */
  test("the CURRENT version decides, and a blocked current version refuses BEFORE the upload", async () => {
    const { parentId, resubmittedId } = await arriveAtResubmitted();
    brokerSetsStatus(resubmittedId, "under_review");
    brokerSetsStatus(parentId, "rejected");

    const before = survivors();
    (supabaseStorageService.uploadAttachments as jest.Mock).mockClear();
    fake.maybeSingleLookups = [];

    const result = await submissionService.submitTransaction(TX);

    /**
     * WHICH ROW DECIDED, BY ID — asserted first, because it is the only
     * assertion that separates this half of the fix from the other half.
     * Remove the ordering and the fail-closed branch still refuses the
     * submit, with a message about a check that could not be made; "the
     * submit was refused" alone would stay green and prove nothing.
     */
    const lookup = fake.maybeSingleLookups.find(
      (l) => l.table === "transaction_submissions"
    );
    expect(lookup).toBeDefined();
    expect(lookup?.matched).toBe(2);
    expect(lookup?.returnedIds).toEqual([resubmittedId]);

    // The refusal is the GUARD's, named by the canonical copy for the status
    // the current version is actually in — not the version-1 `rejected` row
    // that also matches the filters.
    expect(result.success).toBe(false);
    expect(result.error).toBe(BLOCKED_SUBMISSION_MESSAGES.under_review);

    // Before the longest stage, which is the whole point.
    expect(supabaseStorageService.uploadAttachments).not.toHaveBeenCalled();

    // Nothing moved, by id, across all three tables.
    expect(survivors()).toEqual(before);
    expect(idSet(fake.submissions)).toEqual(new Set([parentId, resubmittedId]));
  });

  /**
   * SWEEP, NOT SAMPLE. One row either side of the boundary cannot catch an
   * off-by-one in an ordering fix, so this walks depth 1, 2 and 3 and asserts
   * the row NAMED each time — every version produced by running the app.
   */
  test("versions 1, 2 and 3 — the highest is the one named, by id, at every depth", async () => {
    const named: Record<number, unknown[]> = {};
    const refusedWith: Record<number, string | null> = {};

    const pressSubmit = async (depth: number): Promise<void> => {
      (supabaseStorageService.uploadAttachments as jest.Mock).mockClear();
      fake.maybeSingleLookups = [];
      const result = await submissionService.submitTransaction(TX);
      const lookup = fake.maybeSingleLookups.find(
        (l) => l.table === "transaction_submissions"
      );
      named[depth] = lookup?.returnedIds ?? [];
      refusedWith[depth] = result.error ?? null;
      expect(result.success).toBe(false);
      expect(supabaseStorageService.uploadAttachments).not.toHaveBeenCalled();
    };

    // DEPTH 1 — produced by the app: a first, successful submit.
    resetFake();
    const first = await submissionService.submitTransaction(TX);
    expect(first.success).toBe(true);
    const v1 = first.submissionId;
    if (typeof v1 !== "string") {
      throw new Error(`first submit returned no submissionId: ${JSON.stringify(first)}`);
    }
    expect(fake.submissions.find((r) => r.id === v1)?.status).toBe("submitted");
    await pressSubmit(1);

    // DEPTH 2 — broker sends it back, agent resubmits, broker opens it.
    brokerSetsStatus(v1, "needs_changes");
    const second = await submissionService.resubmitTransaction(TX);
    const v2 = second.submissionId as string;
    expect(fake.submissions.find((r) => r.id === v2)?.version).toBe(2);
    brokerSetsStatus(v2, "under_review");
    await pressSubmit(2);

    // DEPTH 3 — a second round trip.
    brokerSetsStatus(v2, "needs_changes");
    const third = await submissionService.resubmitTransaction(TX);
    const v3 = third.submissionId as string;
    expect(fake.submissions.find((r) => r.id === v3)?.version).toBe(3);
    brokerSetsStatus(v3, "approved");
    await pressSubmit(3);

    // The whole sweep in one comparison: at each depth the lookup named the
    // HIGHEST version, and the refusal quoted the copy for THAT row's status.
    expect(named).toEqual({ 1: [v1], 2: [v2], 3: [v3] });
    expect(refusedWith).toEqual({
      1: BLOCKED_SUBMISSION_MESSAGES.submitted,
      2: BLOCKED_SUBMISSION_MESSAGES.under_review,
      3: BLOCKED_SUBMISSION_MESSAGES.approved,
    });

    // And every version is still there — three rows, three ids.
    expect(fake.submissions.map((r) => r.version).sort()).toEqual([1, 2, 3]);
    expect(idSet(fake.submissions)).toEqual(new Set([v1, v2, v3]));
  });

  /**
   * FAIL CLOSED — the second defect, on its own.
   *
   * Deliberately run on a deal with NO existing submission, which is what
   * makes the control discriminate: with the error dropped, a failed check
   * and a clean deal are the SAME value (`data: null`), so the submit sails
   * through the guard, runs the full upload and inserts a row. Read the
   * error and the same fixture refuses before any of that.
   *
   * A fixture that already had a submission would not separate the two: the
   * ordering fix alone would refuse it, and this test would pass while
   * proving nothing about the error branch.
   */
  test("FAIL CLOSED: a lookup that errors refuses the submit instead of reading as 'never submitted'", async () => {
    resetFake();
    expect(fake.submissions).toHaveLength(0);

    fake.lookupError = { code: "PGRST301", message: "JWT expired" };

    const result = await submissionService.submitTransaction(TX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(
      /Could not check whether this transaction has already been submitted/i
    );
    // The driver's own words are carried through, so the log names the cause.
    expect(result.error).toMatch(/JWT expired/);

    // Refused before the upload, and nothing was written.
    expect(supabaseStorageService.uploadAttachments).not.toHaveBeenCalled();
    expect(survivors()).toEqual({
      submissions: [],
      messages: [],
      attachments: [],
    });
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

    // Survival first — see the note in the LIVE_RLS twin of this test.
    //
    // ONE comparison over all three tables, so a revert shows the WHOLE
    // cascade in a single diff instead of stopping at the first table. With
    // "submitted" removed from blockedStatuses the delete lands, the FK
    // cascade takes the messages and the attachments with it, and the
    // replacement carries a fresh uuid — while the row COUNT stays at one,
    // which is the trap this assertion exists to avoid.
    expect(survivors()).toEqual({
      submissions: [seeded.id],
      messages: [...seeded.messageIds].sort(),
      attachments: [...seeded.attachmentIds].sort(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already been submitted/i);
  });

  /**
   * BACKLOG-2867 — THE CONTROL FOR THE REGRESSION THE FIX ITSELF CREATED.
   *
   * Making the lookup name the current version is what puts a two-row deal in
   * front of the guard for the first time. `resubmitted` is not on the blocked
   * list, so execution reaches the delete branch — now holding VERSION 2 while
   * about to insert version 1. Under the desktop's RLS that delete no-ops, but
   * `service_role_full_access_submissions` is live on this table and grants
   * ALL, and under this disposition the delete LANDS: the current submission
   * and its cascaded messages and attachments are destroyed, and the version-1
   * insert then fails on the unique key regardless. The broker's whole review
   * round trip lost, by a change that was meant to protect it.
   *
   * The `existingVersion !== pendingVersion` condition on the delete is what
   * closes that, and this test is where removing it is a real red.
   */
  test("BACKLOG-2867: a plain submit on a round-tripped deal does NOT delete the current version", async () => {
    const { parentId, resubmittedId } = await arriveAtResubmitted();

    const before = survivors();
    (supabaseStorageService.uploadAttachments as jest.Mock).mockClear();

    const result = await submissionService.submitTransaction(TX);

    // SURVIVAL FIRST, over all three tables in one comparison, so a revert
    // shows the whole cascade rather than stopping at the first table.
    expect(survivors()).toEqual(before);
    expect(idSet(fake.submissions)).toEqual(new Set([parentId, resubmittedId]));

    // The outcome is the pre-existing one and is NOT claimed as fixed: the
    // upload still runs and the insert still dies on the unique key. Closing
    // that window is BACKLOG-2790's reorder.
    expect(result.success).toBe(false);
    expect(supabaseStorageService.uploadAttachments).toHaveBeenCalled();
    expect(result.error).toMatch(/duplicate key/i);
  });

  test("a resubmit from 'needs_changes' does NOT delete its own parent — the row `parent_submission_id` points at is still there", async () => {
    const seeded = seedSubmission("needs_changes", 1);

    const result = await submissionService.resubmitTransaction(TX);
    // PARENT SURVIVAL FIRST. Without the `options?.parentSubmissionId` guard
    // a PERMITTED delete destroys the parent, the FK cascade takes its
    // messages and attachments, the versioned insert then violates
    // transaction_submissions_parent_submission_id_fkey, and
    // `cleanupFailedSubmission` clears what the failed attempt wrote —
    // measured end state: every one of the three tables EMPTY. A legitimate
    // broker round trip losing the whole submission.
    expect(fake.submissions.map((r) => r.id)).toContain(seeded.id);
    expect(fake.messages.map((r) => r.id)).toEqual(
      expect.arrayContaining(seeded.messageIds)
    );
    expect(fake.attachments.map((r) => r.id)).toEqual(
      expect.arrayContaining(seeded.attachmentIds)
    );

    expect(result.success).toBe(true);
    expect(result.error ?? null).toBeNull();

    const fresh = fake.submissions.find((s) => s.id === result.submissionId);
    expect(fresh?.version).toBe(2);
    expect(fresh?.parent_submission_id).toBe(seeded.id);
  });
});
