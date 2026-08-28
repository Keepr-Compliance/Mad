/**
 * BACKLOG-2914 — THE OUTCOME ROW REACHES SENTRY AS AN EVENT.
 *
 * PR #2422 built a complete, verified outcome row and sent it to `log.info`. These
 * tests are about the half that was missing: the row leaving the machine.
 *
 * THE CENTRAL CONTROL is `an EVENT is captured, not a breadcrumb`. BACKLOG-2913/2950
 * established that `backupService` has called `addBreadcrumb` on backup failure for
 * months and that NONE of the founder's five real failures on 2026-08-27 exist in
 * Sentry, because breadcrumbs are discarded unless something else captures an event.
 * A suite that asserted `addBreadcrumb` was called would go green on the bug. So the
 * assertions here are on `captureMessage`, and there is an explicit test that
 * `addBreadcrumb` is NOT the mechanism.
 *
 * `@sentry/electron/*` is mapped to `tests/__mocks__/sentry-electron.js` by
 * `jest.config.js` moduleNameMapper, so `Sentry.captureMessage` is already a jest.fn.
 */

import * as Sentry from "@sentry/electron/main";
import {
  reportOutcomeToSentry,
  reportSyncOutcome,
  buildOutcomeTags,
  scrubOutcomeFields,
  durationBucket,
} from "../syncOutcomeReporter";
import { SyncTimeline, SYNC_OUTCOME_SOURCE } from "../syncTimeline";
import type { SyncOutcomeRow } from "../syncTimeline";

const captureMessage = Sentry.captureMessage as unknown as jest.Mock;
const addBreadcrumb = Sentry.addBreadcrumb as unknown as jest.Mock;

/**
 * A row shaped like a real run: the founder's 2026-08-28 sync, with the fields the
 * orchestrator actually establishes.
 */
function realisticRow(overrides: Partial<SyncOutcomeRow> = {}): SyncOutcomeRow {
  return {
    source: SYNC_OUTCOME_SOURCE,
    outcome: "complete",
    elapsedMs: 3_120_000,
    phases: [
      { phase: "backup:waiting-for-device", elapsedMs: 480_000 },
      { phase: "backup:transferring", elapsedMs: 2_400_000 },
      { phase: "storing:messages", elapsedMs: 240_000 },
    ],
    fields: {
      source: SYNC_OUTCOME_SOURCE,
      outcome: "complete",
      elapsedMs: 3_120_000,
      platform: "darwin",
      deviceModel: "iPhone14,3",
      deviceIosVersion: "18.5",
      deviceUsedBytes: 61_200_000_000,
      deviceFreeBytes: 12_000_000_000,
      hostOsRelease: "24.6.0",
      hostTotalMemBytes: 17_179_869_184,
      hostDiskFreeBytes: 40_000_000_000,
      priorBackup: "exists",
      backupModeSource: "device-reported",
      incremental: false,
      messagesExtracted: 663_722,
      phases: "backup:transferring:2400000",
    },
    ...overrides,
  };
}

beforeEach(() => {
  captureMessage.mockClear();
  addBreadcrumb.mockClear();
});

describe("BACKLOG-2914: the outcome row is captured as a Sentry EVENT", () => {
  it("captures an event", () => {
    reportOutcomeToSentry(realisticRow());
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  /**
   * THE CONTROL THAT DISTINGUISHES THIS FIX FROM THE BUG IT REPLACES.
   *
   * If this module were written the way `backupService` was, `addBreadcrumb` would be
   * called and `captureMessage` would not, and the data would never reach Sentry. This
   * test fails on that implementation; a test asserting `addBreadcrumb` would pass on it.
   */
  it("does NOT rely on a breadcrumb, which would be discarded with no event to attach to", () => {
    reportOutcomeToSentry(realisticRow());
    expect(addBreadcrumb).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalled();
  });

  it("names the outcome in the message so the three outcomes are three stable issues", () => {
    reportOutcomeToSentry(realisticRow({ outcome: "error" }));
    expect(captureMessage.mock.calls[0][0]).toBe("Sync outcome: error");
  });

  it("captures at info level with an explicit fingerprint", () => {
    reportOutcomeToSentry(realisticRow());
    const ctx = captureMessage.mock.calls[0][1];
    expect(ctx.level).toBe("info");
    expect(ctx.fingerprint).toEqual(["sync-outcome", SYNC_OUTCOME_SOURCE, "complete"]);
  });
});

describe("BACKLOG-2914: SUCCESS is emitted, because it is the denominator", () => {
  /**
   * Without the success event a rise in failures and a rise in usage are the same
   * shape in the data. This is the reason the row is emitted at all.
   */
  it("emits an event for a COMPLETE sync, not only for failures", () => {
    reportOutcomeToSentry(realisticRow({ outcome: "complete" }));
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0][1].tags.outcome).toBe("complete");
  });

  it.each(["complete", "cancelled", "error"] as const)("emits for outcome=%s", (outcome) => {
    reportOutcomeToSentry(realisticRow({ outcome }));
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0][1].tags.outcome).toBe(outcome);
  });
});

describe("BACKLOG-2914: tags are what make the row filterable", () => {
  it("tags source and outcome from the row, not from a constant", () => {
    const tags = buildOutcomeTags(realisticRow({ source: "android-companion", outcome: "error" }));
    expect(tags.source).toBe("android-companion");
    expect(tags.outcome).toBe("error");
  });

  it("carries priorBackup, backupModeSource and incremental as tags", () => {
    const tags = buildOutcomeTags(realisticRow());
    expect(tags.priorBackup).toBe("exists");
    expect(tags.backupModeSource).toBe("device-reported");
    expect(tags.incremental).toBe("false");
  });

  it("carries reason_code as a tag when a run has one", () => {
    const row = realisticRow({ outcome: "error" });
    row.fields.reason_code = "device_disconnected";
    expect(buildOutcomeTags(row).reason_code).toBe("device_disconnected");
  });

  /**
   * The same rule `setContext` enforces on the row: a dimension that was not
   * established is ABSENT, never the literal string "undefined".
   */
  it("omits a dimension the run never established rather than tagging it 'undefined'", () => {
    const row = realisticRow();
    delete row.fields.priorBackup;
    const tags = buildOutcomeTags(row);
    expect(tags).not.toHaveProperty("priorBackup");
    expect(Object.values(tags)).not.toContain("undefined");
  });

  it("buckets duration as a tag, because Sentry will not aggregate a number in extra", () => {
    expect(buildOutcomeTags(realisticRow({ elapsedMs: 3_120_000 })).duration_bucket).toBe("30-60m");
    expect(durationBucket(30_000)).toBe("<1m");
    expect(durationBucket(4 * 60_000)).toBe("1-5m");
    expect(durationBucket(10 * 60_000)).toBe("5-15m");
    expect(durationBucket(20 * 60_000)).toBe("15-30m");
    expect(durationBucket(90 * 60_000)).toBe(">60m");
  });

  /**
   * A per-run string of a dozen numbers is unbounded cardinality and exceeds Sentry's
   * 200-character tag cap. It belongs in extra, where it is readable.
   */
  it("keeps the per-run phases string OUT of tags and IN extra", () => {
    reportOutcomeToSentry(realisticRow());
    const ctx = captureMessage.mock.calls[0][1];
    expect(ctx.tags).not.toHaveProperty("phases");
    expect(ctx.extra.phases).toBe("backup:transferring:2400000");
    expect(ctx.extra.phaseDurations).toEqual([
      { phase: "backup:waiting-for-device", elapsedMs: 480_000 },
      { phase: "backup:transferring", elapsedMs: 2_400_000 },
      { phase: "storing:messages", elapsedMs: 240_000 },
    ]);
  });

  it("puts the numbers a regression is diagnosed from in extra", () => {
    reportOutcomeToSentry(realisticRow());
    const extra = captureMessage.mock.calls[0][1].extra;
    expect(extra.deviceModel).toBe("iPhone14,3");
    expect(extra.messagesExtracted).toBe(663_722);
    expect(extra.hostTotalMemBytes).toBe(17_179_869_184);
  });
});

describe("BACKLOG-2914: NO PII leaves the process", () => {
  /**
   * THE FIXTURE HAS BOTH AVAILABLE TO LEAK. A fixture without a UDID and without a
   * device name cannot fail this test and would prove nothing — which is the trap
   * recorded on 2026-08-04 and in this repo's CLAUDE.md.
   *
   * The device name below is a personal-nickname shape on purpose: the founder's is.
   */
  const leakyFields = {
    udid: "00008030-001A2C3E1E88802E",
    deviceName: "Danny Boy's iPhone",
    serialNumber: "F2LX93KJQ1GH",
    // `testuser` IS THE POINT. BACKLOG-2657 records a real developer home directory
    // still sitting in a fixture on `main`, and this repo is PUBLIC. The PII pre-push
    // scan does NOT catch username-in-path, so nothing but this comment stops the next
    // person pasting their own `/Users/<name>` here. Never a real one.
    backupPath: "/Users/testuser/Library/Application Support/keepr/backup",
    deviceModel: "iPhone14,3",
    elapsedMs: 3_120_000,
  };

  it("drops a UDID and a device name that a producer put on the row", () => {
    const safe = scrubOutcomeFields(leakyFields);
    expect(safe).not.toHaveProperty("udid");
    expect(safe).not.toHaveProperty("deviceName");
    expect(safe).not.toHaveProperty("serialNumber");
    expect(safe).not.toHaveProperty("backupPath");
    // and keeps everything legitimate
    expect(safe.deviceModel).toBe("iPhone14,3");
    expect(safe.elapsedMs).toBe(3_120_000);
  });

  it("drops a UDID smuggled under an innocent key name, by value shape", () => {
    const safe = scrubOutcomeFields({ deviceIdentifier: "00008030-001A2C3E1E88802E" });
    expect(safe).not.toHaveProperty("deviceIdentifier");
    const legacy = scrubOutcomeFields({ ref: "a".repeat(40) });
    expect(legacy).not.toHaveProperty("ref");
  });

  /**
   * Asserted on the SERIALIZED payload, not on the scrub helper, so a future change
   * that bypasses the helper on its way to Sentry is caught here.
   */
  it("sends neither the UDID nor the device name in the captured event payload", () => {
    const row = realisticRow();
    Object.assign(row.fields, leakyFields);
    reportOutcomeToSentry(row);

    const payload = JSON.stringify(captureMessage.mock.calls[0]);
    expect(payload).not.toContain("00008030-001A2C3E1E88802E");
    expect(payload).not.toContain("Danny Boy");
    expect(payload).not.toContain("F2LX93KJQ1GH");
    expect(payload).not.toContain("/Users/testuser");
    // the fixture really did carry them, so this test could have failed
    expect(JSON.stringify(leakyFields)).toContain("00008030-001A2C3E1E88802E");
    expect(payload).toContain("iPhone14,3");
  });
});

describe("BACKLOG-2914: telemetry never costs the user a sync", () => {
  it("swallows a throwing Sentry client rather than failing the sync", () => {
    captureMessage.mockImplementationOnce(() => {
      throw new Error("sentry client not initialised");
    });
    expect(() => reportSyncOutcome(realisticRow())).not.toThrow();
  });
});

describe("BACKLOG-2914: THE WIRING — the real timeline reaches Sentry", () => {
  /**
   * THE CONTROL THIS ITEM EXISTS FOR.
   *
   * The previous attempt built a complete row and wired it to nothing. Every test
   * above would pass on that code, because they call the reporter directly. This one
   * drives a `SyncTimeline` with NO reporter injected — i.e. production wiring — and
   * goes red the moment the default reporter is removed from the constructor.
   */
  it("emits a Sentry event from an un-injected SyncTimeline on endSync", () => {
    const timeline = new SyncTimeline({ sink: () => {} });
    timeline.beginSync({ platform: "darwin" });
    timeline.setContext({ deviceModel: "iPhone14,3", priorBackup: "exists" });
    timeline.enter("backup:transferring");
    timeline.endSync("complete", { messagesExtracted: 663_722 });

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, ctx] = captureMessage.mock.calls[0];
    expect(message).toBe("Sync outcome: complete");
    expect(ctx.tags.source).toBe(SYNC_OUTCOME_SOURCE);
    expect(ctx.tags.outcome).toBe("complete");
    expect(ctx.tags.priorBackup).toBe("exists");
    expect(ctx.extra.deviceModel).toBe("iPhone14,3");
    expect(ctx.extra.messagesExtracted).toBe(663_722);
  });

  it("emits exactly one event per sync, so the denominator is not double-counted", () => {
    const timeline = new SyncTimeline({ sink: () => {} });
    timeline.beginSync();
    timeline.endSync("complete");
    timeline.endSync("complete"); // stray second call, guarded by `wasOpen`
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it("a throwing reporter does not break endSync", () => {
    const timeline = new SyncTimeline({
      sink: () => {},
      reporter: () => {
        throw new Error("transport exploded");
      },
    });
    timeline.beginSync();
    expect(() => timeline.endSync("complete")).not.toThrow();
  });
});
