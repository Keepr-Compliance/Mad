/**
 * BACKLOG-3910 (slice b): canonical/mirror parity for the locked-deal rule, and
 * exhaustiveness against the schema.
 *
 * The rule lives twice because nothing under `electron/` may import from `src/`
 * and the renderer cannot value-import from `electron/`. This test imports BOTH
 * and asserts the same verdict for every status the schema allows, plus NULL,
 * undefined, "" and an unknown value. It also reads the CHECK list out of
 * `electron/database/schema.sql`, so a new submission status that neither map
 * names fails here (C-R3h) instead of silently counting as open.
 */
import fs from "fs";
import path from "path";
import * as canonical from "../../../electron/services/transactionEligibility";
import * as mirror from "../dealLock";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "electron", "database", "schema.sql"),
  "utf8",
);

function schemaStatuses(): string[] {
  const m = SCHEMA.match(
    /submission_status TEXT DEFAULT 'not_submitted' CHECK \(submission_status IN \(([^)]*)\)\)/,
  );
  if (!m) throw new Error("transactions.submission_status CHECK list not found in schema.sql");
  return m[1].split(",").map((s) => s.trim().replace(/'/g, ""));
}

describe("dealLock parity (canonical vs renderer mirror)", () => {
  it("C-R3h: both maps name exactly the schema's submission statuses", () => {
    const statuses = schemaStatuses().sort();
    expect(statuses.length).toBeGreaterThan(0);
    expect(Object.keys(canonical.DEAL_LOCK_REASON_BY_STATUS).sort()).toEqual(statuses);
    expect(Object.keys(mirror.DEAL_LOCK_REASON_BY_STATUS).sort()).toEqual(statuses);
  });

  it("the same verdict for every schema status and every empty / unknown input", () => {
    const inputs: Array<string | null | undefined> = [...schemaStatuses(), null, undefined, "", "archived"];
    for (const s of inputs) {
      expect([s, mirror.dealLockReason(s)]).toEqual([s, canonical.dealLockReason(s)]);
    }
  });

  it("the 2.41 mapping, written out (founder ruling 2026-10-11)", () => {
    const verdicts = Object.fromEntries(
      schemaStatuses().map((s) => [s, canonical.dealLockReason(s)]),
    );
    expect(verdicts).toEqual({
      not_submitted: null,
      submitted: "submitted",
      under_review: "submitted",
      needs_changes: null,
      resubmitted: "submitted",
      approved: "sealed",
      rejected: null,
    });
    expect(canonical.dealLockReason(null)).toBeNull();
  });

  it("every lock reason has notice copy and a Sync tooltip", () => {
    const reasons = new Set(
      Object.values(mirror.DEAL_LOCK_REASON_BY_STATUS).filter((r): r is mirror.DealLockReason => r !== null),
    );
    expect([...reasons].sort()).toEqual(["sealed", "submitted"]);
    for (const r of reasons) {
      expect(mirror.DEAL_LOCK_NOTICE_COPY[r]).toEqual(expect.stringContaining("You can still attach them yourself."));
      expect(mirror.DEAL_LOCK_SYNC_TOOLTIP[r]).toEqual(expect.any(String));
    }
  });
});
