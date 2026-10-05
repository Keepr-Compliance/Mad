/**
 * BACKLOG-3734 — the start and closing dates printed in the CSV header and
 * SUMMARY.txt are the days the agent entered, in every zone (closing date via
 * `auditWindowEnd`).
 *
 * `new Date("2026-09-24").toLocaleDateString()` prints 9/23 west of UTC (UTC
 * midnight is the previous evening there). The headers now go through
 * `auditWindowStart`, which reads a date-only value as LOCAL midnight.
 *
 * Section 1 asserts against the LOCAL day, so it is correct in any zone — but
 * in UTC the old parse prints the same day, so it cannot see a revert there.
 * Section 2 re-runs this file in child jest processes pinned to
 * America/Chicago, UTC and Asia/Tokyo (a jest test cannot change its own zone;
 * see `tests/support/auditWindowZoneProbe.ts`), so a UTC CI box still checks
 * the zones where the bug shows.
 */

import path from "path";
import { spawnSync } from "child_process";

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

import type { TransactionWithDetails } from "../transactionService/types";
import enhancedExportService from "../enhancedExportService";
import { testExportPlan } from "./helpers/exportPlanFixture";

const IS_CHILD = process.env.KEEPR_3734_ZONE_CHILD === "1";

const transaction = {
  id: "txn-3734",
  user_id: "user-1",
  property_address: "1 Start Street",
  started_at: "2026-09-24",
  closed_at: "2026-09-24",
} as unknown as TransactionWithDetails;

/** The day as the agent's machine prints it — never derived from the code under test. */
const LOCAL_DAY = new Date(2026, 8, 24).toLocaleDateString();

function headerLine(prefix: string): string {
  const line = writtenFiles
    .flatMap((f) => f.content.split("\n"))
    .find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`no "${prefix}" line was written`);
  return line;
}

describe("BACKLOG-3734 — export headers print the entered start day (this zone)", () => {
  beforeEach(() => {
    writtenFiles.length = 0;
  });

  it("names this process's zone when run as a pinned child", () => {
    if (IS_CHILD) {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(process.env.KEEPR_3734_EXPECT_TZ);
    }
  });

  it("CSV header: Representation Start and Closing Date are the local day", async () => {
    await enhancedExportService.exportTransaction(transaction, testExportPlan([], { format: "csv" }), {
      exportFormat: "csv",
    });
    expect(headerLine("Representation Start:")).toBe(`Representation Start: ${LOCAL_DAY}`);
    expect(headerLine("Closing Date:")).toBe(`Closing Date: ${LOCAL_DAY}`);
  });

  it("SUMMARY.txt: Representation Start Date and Closing Date are the local day", async () => {
    await enhancedExportService.exportTransaction(transaction, testExportPlan([], { format: "txt_eml" }), {
      exportFormat: "txt_eml",
    });
    expect(headerLine("Representation Start Date:")).toBe(`Representation Start Date: ${LOCAL_DAY}`);
    expect(headerLine("Closing Date:")).toBe(`Closing Date: ${LOCAL_DAY}`);
  });
});

(IS_CHILD ? describe.skip : describe)("BACKLOG-3734 — export headers, zone-pinned", () => {
  const ZONE_TIMEOUT_MS = 180_000;

  /** Runs this file in a child jest pinned to `tz`; requires exit 0 AND the 3 header tests run (the 3 zone tests skip in the child). */
  function expectChildGreen(tz: string): void {
    const res = spawnSync(
      process.execPath,
      [
        path.join(__dirname, "..", "..", "..", "node_modules", "jest", "bin", "jest.js"),
        "--runTestsByPath",
        __filename,
        "--ci",
        "--bail=0",
        "--coverage=false",
      ],
      {
        cwd: path.join(__dirname, "..", "..", ".."),
        env: {
          ...process.env,
          TZ: tz,
          ELECTRON_RUN_AS_NODE: "1",
          KEEPR_3734_ZONE_CHILD: "1",
          KEEPR_3734_EXPECT_TZ: tz,
        },
        encoding: "utf8",
        timeout: ZONE_TIMEOUT_MS,
      },
    );
    const output = `${res.stderr ?? ""}\n${res.stdout ?? ""}`;
    // A child that ran ZERO tests also "passes" if only the exit code is read.
    expect([tz, res.status, /Tests:\s+3 skipped, 3 passed, 6 total/.test(output) ? "3 passed" : output]).toEqual([
      tz,
      0,
      "3 passed",
    ]);
  }

  it.each(["America/Chicago", "UTC", "Asia/Tokyo"])(
    "%s: both headers print the entered start and closing day",
    (tz) => {
      expectChildGreen(tz);
    },
    ZONE_TIMEOUT_MS,
  );
});
