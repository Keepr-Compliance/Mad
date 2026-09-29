/**
 * @jest-environment node
 */

/**
 * BACKLOG-3519 / BACKLOG-3520 (commission figures only) — `mapToSubmission`'s
 * copy of the four local `commission_*` columns onto the submission record.
 *
 * Exercised directly through reflection (the established pattern in
 * `submissionService.test.ts`), not through a full `submitTransaction()` run:
 * the mapping touches no attachment upload, message loading or party-name
 * resolution. The split snapshot that an earlier revision of this item also
 * copied is gone (founder decision, pm_comments 4d2e15df on BACKLOG-3519).
 */

jest.mock("../supabaseService");
jest.mock("../supabaseStorageService");
jest.mock("../databaseService");
jest.mock("../logService");
jest.mock("../contactsService");
jest.mock("electron", () => ({
  app: { getVersion: jest.fn().mockReturnValue("2.0.0") },
}));

import { submissionService } from "../submissionService";
import type { Transaction } from "../../types/models";

const ORG_ID = "00000000-0000-4000-8000-000000351900"; // pii-allow-uuid: invented fixture id
const AGENT_ID = "00000000-0000-4000-8000-000000351901"; // pii-allow-uuid: invented fixture id

/** `mapToSubmission` is private; the mapping it produces is the subject. */
function mapToSubmission(
  transaction: Partial<Transaction> & { id: string; property_address: string }
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
        options: undefined
      ): Record<string, unknown>;
    }
  ).mapToSubmission(transaction as Transaction, ORG_ID, AGENT_ID, "sub-3519", 0, 0, undefined);
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

describe("BACKLOG-3520 — what goes on the wire", () => {
  it("serialises the four commission keys when figures are entered, and NO split_ key ever", () => {
    const body = JSON.parse(
      JSON.stringify(
        mapToSubmission({
          ...baseTransaction,
          commission_offered_rate: 2.5,
          commission_actual_rate: 2.375,
          commission_gross_amount: 9796.88,
          commission_adjustment_reason: "Reduced to close the deal",
        })
      )
    );
    expect(Object.keys(body).filter((k) => k.startsWith("commission_")).sort()).toEqual([
      "commission_actual_rate",
      "commission_adjustment_reason",
      "commission_gross_amount",
      "commission_offered_rate",
    ]);
    expect(Object.keys(body).filter((k) => k.startsWith("split_"))).toEqual([]);
  });

  it("serialises NO commission key when the agent entered nothing (a database without the columns still accepts the insert)", () => {
    const body = JSON.parse(JSON.stringify(mapToSubmission({ ...baseTransaction })));
    expect(Object.keys(body).filter((k) => k.startsWith("commission_") || k.startsWith("split_"))).toEqual([]);
  });

  it("serialises NO commission key when the stored values are NULL (a cleared form)", () => {
    const body = JSON.parse(
      JSON.stringify(
        mapToSubmission({
          ...baseTransaction,
          commission_offered_rate: null as unknown as undefined,
          commission_actual_rate: null as unknown as undefined,
          commission_gross_amount: null as unknown as undefined,
          commission_adjustment_reason: null as unknown as undefined,
        })
      )
    );
    expect(Object.keys(body).filter((k) => k.startsWith("commission_"))).toEqual([]);
  });
});
