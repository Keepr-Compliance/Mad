/**
 * enhancedExportService — the service RENDERS a plan; it does not decide one.
 *
 * TASK-1143 / BACKLOG-2343 history: this suite used to reach through a typed
 * cast into `_filterCommunicationsByDate`, a private hand-copy of the folder
 * handler's inline date filter. BACKLOG-2771 deleted that copy — there is now
 * one resolver, and every BACKLOG-2343 closing-day case this file used to own
 * is ported verbatim into `exportPlan.test.ts`, with the per-entry-point
 * routing pinned in `exportIncludeSet-2771.test.ts`.
 *
 * What remains this file's job is the claim that made the deletion safe: this
 * service writes exactly `plan.communications` and applies NO include-set
 * decision of its own. If a filter is ever re-introduced here, these tests red.
 */

import type { Communication } from "../../types/models";
import type { TransactionWithDetails } from "../transactionService/types";

// enhancedExportService (→ folderExportService → databaseService) only needs
// electron's `app` mocked at import time; the DB layer is auto-mocked via the
// jest moduleNameMapper. Mirrors exportSecurityService.test.ts.
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/tmp/test-downloads"),
  },
}));

const writtenFiles: Array<{ path: string; content: string }> = [];

jest.mock("fs/promises", () => ({
  writeFile: jest.fn(async (p: string, content: string) => {
    writtenFiles.push({ path: p, content });
  }),
  mkdir: jest.fn().mockResolvedValue(undefined),
}));

import enhancedExportService from "../enhancedExportService";
// BACKLOG-2771: plans are built by the REAL resolver, never by hand.
import { testExportPlan } from "./helpers/exportPlanFixture";

const comm = (
  id: string,
  sentAt: string,
  type: "email" | "sms" = "email",
): Communication =>
  ({
    id,
    sent_at: sentAt,
    subject: `Subject ${id}`,
    sender: "test@example.com",
    recipients: "recipient@example.com",
    body_plain: `Body ${id}`,
    communication_type: type,
    channel: type,
  }) as unknown as Communication;

const transaction = {
  id: "txn-2771",
  user_id: "user-1",
  property_address: "27 Plan Street",
  started_at: "2024-01-01",
  closed_at: "2024-12-31",
} as unknown as TransactionWithDetails;

/** IDs in the JSON artifact, in the order the service wrote them. */
const exportedIds = (): string[] => {
  const json = writtenFiles.find((f) => f.path.endsWith(".json"));
  if (!json) throw new Error("no JSON artifact was written");
  return (JSON.parse(json.content).communications as Array<{ id: string }>).map((c) => c.id);
};

describe("enhancedExportService renders exactly the plan it is given", () => {
  beforeEach(() => {
    writtenFiles.length = 0;
    jest.clearAllMocks();
  });

  const all = [
    comm("jan", "2024-01-05T10:00:00Z"),
    comm("feb", "2024-02-05T10:00:00Z", "sms"),
    comm("mar", "2024-03-05T10:00:00Z"),
  ];

  it("writes every communication the plan includes", async () => {
    const plan = testExportPlan(all, { format: "json" });

    await enhancedExportService.exportTransaction(transaction, plan, {
      exportFormat: "json",
    });

    // Descending — the service owns the ORDER, the plan owns the SET.
    expect(exportedIds()).toEqual(["mar", "feb", "jan"]);
  });

  it("writes NOTHING the plan excluded — the audit window is honored via the plan", async () => {
    const plan = testExportPlan(all, {
      format: "json",
      startDate: "2024-02-01",
      endDate: "2024-02-28",
    });

    await enhancedExportService.exportTransaction(transaction, plan, {
      exportFormat: "json",
    });

    expect(exportedIds()).toEqual(["feb"]);
  });

  it("does NOT re-apply a content filter of its own", async () => {
    // The plan selected emails only. This service is never told the content
    // type any more, so the artifact proves the plan alone determined the set.
    const plan = testExportPlan(all, { format: "json", contentType: "emails" });

    await enhancedExportService.exportTransaction(transaction, plan, {
      exportFormat: "json",
    });

    expect(exportedIds()).toEqual(["mar", "jan"]);
  });

  it("does NOT re-apply a date filter of its own", async () => {
    // A plan resolved with NO window must be rendered whole, even though the
    // transaction carries started_at/closed_at that would exclude this row. A
    // surviving second filter reading transaction.closed_at would drop it.
    const outside = comm("2030", "2030-06-01T10:00:00Z");
    const plan = testExportPlan([...all, outside], { format: "json" });

    await enhancedExportService.exportTransaction(transaction, plan, {
      exportFormat: "json",
    });

    expect(exportedIds()).toContain("2030");
    expect(exportedIds()).toHaveLength(4);
  });

  it("renders an empty plan as an empty artifact rather than falling back to the transaction", async () => {
    const plan = testExportPlan(all, {
      format: "json",
      startDate: "2025-01-01",
      endDate: "2025-01-02",
    });

    await enhancedExportService.exportTransaction(transaction, plan, {
      exportFormat: "json",
    });

    expect(exportedIds()).toEqual([]);
  });
});
