/**
 * @jest-environment node
 */

/**
 * BACKLOG-3519 (Commission M2, figures only) — the two units this item adds
 * to the submit pipeline: `mapToSubmission`'s copy of the four local
 * `commission_*` columns, and `resolveSplitSnapshot`'s resolution of the
 * frozen split snapshot via the `split_agreement_in_force` RPC.
 *
 * Both are exercised directly through reflection (the established pattern in
 * `submissionService.test.ts`), not through a full `submitTransaction()` run:
 * neither touches attachment upload, message loading or party-name
 * resolution, so driving the whole pipeline would mock more than it tests.
 * `resolveSplitSnapshot`'s `client` parameter is a hand-built object exposing
 * only `.rpc`, backed by the shared `postgrestEmulator` helper
 * (BACKLOG-3364) extended for `split_agreement_in_force` -- reusing its
 * rows/rpc-call tracking rather than a parallel mock.
 */

jest.mock("../supabaseService");
jest.mock("../supabaseStorageService");
jest.mock("../databaseService");
jest.mock("../logService");
jest.mock("../contactsService");
jest.mock("electron", () => ({
  app: { getVersion: jest.fn().mockReturnValue("2.0.0") },
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import { submissionService } from "../submissionService";
import logService from "../logService";
import { createPostgrestEmulator, type Emulator } from "./helpers/postgrestEmulator";
import type { Transaction } from "../../types/models";

const ORG_ID = "00000000-0000-4000-8000-000000351900"; // pii-allow-uuid: invented fixture id
const AGENT_ID = "00000000-0000-4000-8000-000000351901"; // pii-allow-uuid: invented fixture id
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000351902"; // pii-allow-uuid: invented fixture id

/** `mapToSubmission` is private; the mapping it produces is the subject. */
function mapToSubmission(
  transaction: Partial<Transaction> & { id: string; property_address: string },
  splitSnapshot?: Record<string, unknown>
): Record<string, unknown> {
  return (
    submissionService as unknown as {
      mapToSubmission(
        t: Transaction,
        orgId: string,
        userId: string,
        submissionId: string,
        messageCount: number,
        attachmentCount: number,
        options: undefined,
        splitSnapshot?: Record<string, unknown>
      ): Record<string, unknown>;
    }
  ).mapToSubmission(
    transaction as Transaction,
    ORG_ID,
    AGENT_ID,
    "sub-3519",
    0,
    0,
    undefined,
    splitSnapshot
  );
}

/** `resolveSplitSnapshot` is private; its resolution logic is the subject. */
function resolveSplitSnapshot(
  client: SupabaseClient,
  orgId: string,
  agentUserId: string,
  closedAt: string | undefined
): Promise<Record<string, unknown>> {
  return (
    submissionService as unknown as {
      resolveSplitSnapshot(
        c: SupabaseClient,
        o: string,
        a: string,
        d: string | undefined
      ): Promise<Record<string, unknown>>;
    }
  ).resolveSplitSnapshot(client, orgId, agentUserId, closedAt);
}

const baseTransaction = { id: "txn-3519", property_address: "1 Main St" };

describe("BACKLOG-3519 — mapToSubmission copies the commission figures", () => {
  it("copies all four fields verbatim when present", () => {
    const record = mapToSubmission({
      ...baseTransaction,
      commission_offered_rate: 2.5,
      commission_actual_rate: 2.375,
      commission_gross_amount: 2375.0,
      commission_adjustment_reason: "negotiated at closing",
    });

    expect(record.commission_offered_rate).toBe(2.5);
    expect(record.commission_actual_rate).toBe(2.375);
    expect(record.commission_gross_amount).toBe(2375.0);
    expect(record.commission_adjustment_reason).toBe("negotiated at closing");
  });

  it("preserves an exact-zero rate (?? not ||) -- a legal, CHECK-permitted value", () => {
    const record = mapToSubmission({
      ...baseTransaction,
      commission_offered_rate: 0,
      commission_actual_rate: 0,
    });

    expect(record.commission_offered_rate).toBe(0);
    expect(record.commission_actual_rate).toBe(0);
  });

  it("treats an empty-string reason as absent, not as a value that would fail the CHECK", () => {
    const record = mapToSubmission({
      ...baseTransaction,
      commission_adjustment_reason: "",
    });

    expect(record.commission_adjustment_reason).toBeUndefined();
  });

  it("leaves every commission field undefined when the transaction has none set", () => {
    const record = mapToSubmission({ ...baseTransaction });

    expect(record.commission_offered_rate).toBeUndefined();
    expect(record.commission_actual_rate).toBeUndefined();
    expect(record.commission_gross_amount).toBeUndefined();
    expect(record.commission_adjustment_reason).toBeUndefined();
  });
});

describe("BACKLOG-3519 — mapToSubmission merges the split snapshot without inventing keys", () => {
  it("adds no split_* OWN KEY at all when nothing was resolved ({})", () => {
    const record = mapToSubmission({ ...baseTransaction }, {});

    for (const key of [
      "split_agreement_id",
      "split_agent_pct",
      "split_brokerage_pct",
      "split_effective_from",
      "split_resolved_on",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(false);
    }
    // Belt-and-suspenders: mirrors the real wire check (JSON.stringify drops
    // undefined; an absent key is stronger still) -- see SubmissionRecord's
    // own comment on why this distinction is load-bearing today.
    expect(JSON.stringify(record)).not.toContain("split_");
  });

  it("carries every resolved field through when a split was found", () => {
    const record = mapToSubmission(
      { ...baseTransaction },
      {
        split_resolved_on: "2026-03-15",
        split_agreement_id: "agreement-1",
        split_agent_pct: 70,
        split_brokerage_pct: 30,
        split_effective_from: "2026-01-01",
      }
    );

    expect(record).toMatchObject({
      split_resolved_on: "2026-03-15",
      split_agreement_id: "agreement-1",
      split_agent_pct: 70,
      split_brokerage_pct: 30,
      split_effective_from: "2026-01-01",
    });
  });
});

describe("BACKLOG-3519 — resolveSplitSnapshot", () => {
  let emulator: Emulator;
  let client: SupabaseClient;

  beforeEach(() => {
    jest.clearAllMocks();
    emulator = createPostgrestEmulator();
    client = { rpc: emulator.rpc } as unknown as SupabaseClient;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves against closed_at, not the submission date, when closed_at is set", async () => {
    emulator.set({
      rows: {
        agent_split_agreements: [
          {
            organization_id: ORG_ID,
            agent_user_id: AGENT_ID,
            id: "agreement-1",
            agent_pct: 70,
            brokerage_pct: 30,
            effective_from: "2026-01-01",
            seq: 1,
          },
        ],
      },
    });

    const result = await resolveSplitSnapshot(
      client,
      ORG_ID,
      AGENT_ID,
      "2026-03-15T10:00:00.000Z"
    );

    // Not today's real date -- proves closed_at drove the resolution, not
    // `new Date()`.
    expect(result.split_resolved_on).toBe("2026-03-15");
    expect(result).toMatchObject({
      split_agreement_id: "agreement-1",
      split_agent_pct: 70,
      split_brokerage_pct: 30,
      split_effective_from: "2026-01-01",
    });
  });

  it("falls back to the submission date when closed_at is null", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-06-01T12:00:00.000Z"));

    const result = await resolveSplitSnapshot(client, ORG_ID, AGENT_ID, undefined);

    expect(result).toEqual({ split_resolved_on: "2026-06-01" });
  });

  describe("UTC day-boundary sweep -- toISOString() truncation, not local time", () => {
    it.each([
      // [closedAt (with a non-UTC offset), expected UTC date]
      ["2026-03-15T23:30:00-07:00", "2026-03-16"], // 06:30 UTC next day
      ["2026-03-15T04:00:00-07:00", "2026-03-15"], // 11:00 UTC same day
      ["2026-03-15T00:00:00Z", "2026-03-15"], // exact UTC midnight
      ["2026-03-15T23:59:59Z", "2026-03-15"], // one second before UTC rollover
    ])("closed_at %s resolves to %s", async (closedAt, expected) => {
      const result = await resolveSplitSnapshot(client, ORG_ID, AGENT_ID, closedAt);
      expect(result.split_resolved_on).toBe(expected);
    });
  });

  it("resolves to {} -- never throws -- when the function is missing (BACKLOG-3503 unapplied)", async () => {
    emulator.set({ splitFunctionPresent: false });

    await expect(
      resolveSplitSnapshot(client, ORG_ID, AGENT_ID, "2026-03-15T00:00:00Z")
    ).resolves.toEqual({});
    // The quiet path: BACKLOG-3503 not being applied yet is expected, not a
    // warning-worthy surprise.
    expect(logService.info).toHaveBeenCalled();
    expect(logService.warn).not.toHaveBeenCalled();
  });

  it("resolves to {} -- never throws -- on an unexpected RPC error, logged louder", async () => {
    const flaky: SupabaseClient = {
      rpc: async () => ({
        data: null,
        error: { code: "XX000", message: "connection reset" },
      }),
    } as unknown as SupabaseClient;

    await expect(
      resolveSplitSnapshot(flaky, ORG_ID, AGENT_ID, "2026-03-15T00:00:00Z")
    ).resolves.toEqual({});
    expect(logService.warn).toHaveBeenCalled();
    expect(logService.info).not.toHaveBeenCalled();
  });

  it("resolves to {} -- never throws -- when the client itself throws synchronously", async () => {
    const throwing: SupabaseClient = {
      rpc: () => {
        throw new Error("network down");
      },
    } as unknown as SupabaseClient;

    await expect(
      resolveSplitSnapshot(throwing, ORG_ID, AGENT_ID, "2026-03-15T00:00:00Z")
    ).resolves.toEqual({});
  });

  it("resolves to {split_resolved_on} only -- zero rows is a clean SUCCESS, not an error", async () => {
    // Stands in for a deactivated agent: agent_split_agreements_select_writer /
    // _select_own (BACKLOG-3503) make a suspended member's own row invisible
    // over RLS, so split_agreement_in_force answers zero rows, not an error --
    // that RLS behaviour itself is proved by controls C23/C24 in
    // supabase/tests/backlog-3503/, not here. This only proves
    // resolveSplitSnapshot treats "found nothing" as distinct from "failed":
    // a row exists, but for a DIFFERENT agent, so the filter finds nothing.
    emulator.set({
      rows: {
        agent_split_agreements: [
          {
            organization_id: ORG_ID,
            agent_user_id: OTHER_AGENT_ID,
            id: "agreement-other",
            agent_pct: 70,
            brokerage_pct: 30,
            effective_from: "2026-01-01",
            seq: 1,
          },
        ],
      },
    });

    const result = await resolveSplitSnapshot(
      client,
      ORG_ID,
      AGENT_ID,
      "2026-03-15T00:00:00Z"
    );

    expect(result).toEqual({ split_resolved_on: "2026-03-15" });
  });

  // MEASURED EQUIVALENT MUTANT: `resolveSplitSnapshot` reads `rows[0]`. Its
  // source was mutated to `rows[rows.length - 1]` and every test here still
  // passed -- both the real SQL function and this emulator apply `LIMIT 1`
  // before the array ever reaches desktop code, so the array is never longer
  // than 1 and the two indices are always the same element. `rows[0]` is
  // correct; it just cannot be distinguished from the alternative BY this
  // code path. What this test actually verifies is that the EMULATOR's sort
  // (effective_from DESC, seq DESC, matching the real function's own ORDER
  // BY) is the fixture behind every other test in this file, not an
  // untested assumption.
  it("the emulator resolves the row in force by effective_from DESC, seq DESC", async () => {
    emulator.set({
      rows: {
        agent_split_agreements: [
          {
            organization_id: ORG_ID,
            agent_user_id: AGENT_ID,
            id: "agreement-old",
            agent_pct: 50,
            brokerage_pct: 50,
            effective_from: "2026-01-01",
            seq: 1,
          },
          {
            organization_id: ORG_ID,
            agent_user_id: AGENT_ID,
            id: "agreement-new",
            agent_pct: 70,
            brokerage_pct: 30,
            effective_from: "2026-02-01",
            seq: 2,
          },
        ],
      },
    });

    const result = await resolveSplitSnapshot(
      client,
      ORG_ID,
      AGENT_ID,
      "2026-03-15T00:00:00Z"
    );

    expect(result.split_agreement_id).toBe("agreement-new");
  });

  it("does not resolve an agreement dated AFTER the on_date", async () => {
    emulator.set({
      rows: {
        agent_split_agreements: [
          {
            organization_id: ORG_ID,
            agent_user_id: AGENT_ID,
            id: "agreement-future",
            agent_pct: 70,
            brokerage_pct: 30,
            effective_from: "2026-05-01",
            seq: 1,
          },
        ],
      },
    });

    const result = await resolveSplitSnapshot(
      client,
      ORG_ID,
      AGENT_ID,
      "2026-03-15T00:00:00Z"
    );

    expect(result).toEqual({ split_resolved_on: "2026-03-15" });
  });
});
