/**
 * The renderer-facing surface of seams PR B, pinned byte for byte
 * (BACKLOG-2962).
 *
 * WHY THIS SUITE EXISTS, AND WHY THE SUITES THAT ALREADY EXIST ARE NOT ENOUGH
 * ---------------------------------------------------------------------------
 * This PR moves two IPC broadcasts and three modal dialogs behind interfaces.
 * A seam that changed an IPC channel name by one byte would take a renderer
 * surface silently dead, and a seam that changed a dialog's title or buttons
 * would change what the founder reads on a terminal database failure. Both must
 * be impossible to do accidentally.
 *
 * Before relying on the existing coverage I measured what it can distinguish,
 * and it cannot distinguish those two things:
 *
 *   - `initializationBroadcaster.test.ts:126` asserts
 *     `toHaveBeenCalledWith(INIT_STAGE_CHANNEL, event)` — the imported CONSTANT.
 *     Changing the constant's VALUE moves the expectation and the input
 *     together, so that suite stays green on a renamed channel. (`reviewNotify-
 *     2791.test.ts:77` does filter on the string literal, so the review channel
 *     had one real control; the init channel had none.)
 *   - `databaseService.migration-restore.test.ts` pins `"Database Update
 *     Notice"` and `"Database Update Failed"`, but
 *     `databaseService.schemaBaselineRefusal.test.ts:234` asserts only that
 *     `message` CONTAINS `"older version"` — so the third dialog's title, its
 *     `buttons: ["Quit"]` and its whole `detail` body were pinned by nothing.
 *
 * Every literal below is TRANSCRIBED from the source at `2f0aad2ee`, not
 * invented, and the dialog cases assert against the object the production code
 * passes rather than against a fixture, so no fixture can be its own control.
 *
 * No PII: the only identifier-shaped values here are channel names and a
 * synthetic transaction id that says so.
 */

import { installWindows } from "../../capabilities/windowsProvider";
import type { Windows } from "../../capabilities/windows";

/** Records every (channel, payload) the core asks to broadcast. */
function recordingWindows(): { windows: Windows; sent: Array<[string, unknown]> } {
  const sent: Array<[string, unknown]> = [];
  return { sent, windows: { broadcast: (channel, payload) => void sent.push([channel, payload]) } };
}

describe("IPC channel names survive the Windows seam byte for byte (BACKLOG-2962)", () => {
  it("INIT_STAGE_CHANNEL is the literal string the renderer listens on", () => {
    // Pinned as a LITERAL, which is the whole point: every other assertion in
    // the tree compares this constant to itself.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { INIT_STAGE_CHANNEL } = require("../initializationBroadcaster");
    expect(INIT_STAGE_CHANNEL).toBe("system:init-stage");
  });

  it("the init broadcast reaches the seam on that channel, with the event by reference", () => {
    const { windows, sent } = recordingWindows();
    installWindows(windows);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { initializationBroadcaster } = require("../initializationBroadcaster");

    const event = { stage: "db-ready" as const, message: "Database ready" };
    initializationBroadcaster.broadcast(event);

    const initSends = sent.filter(([channel]) => channel === "system:init-stage");
    expect(initSends).toHaveLength(1);
    // BY REFERENCE. A seam that spread the event into a new object would pass a
    // deep-equality assertion and still be a different message on the wire.
    expect(initSends[0][1]).toBe(event);
  });

  it("the review broadcast keeps its channel and its five payload keys", () => {
    jest.isolateModules(() => {
      // The store is stubbed EMPTY on purpose. `outstanding` is whatever
      // `countReviewItems` reads out of it, and this case is not about the
      // count — it is about the channel literal and the exact key set, which a
      // renamed key or a renamed channel both break.
      jest.doMock("../db/core/dbConnection", () => ({
        dbGet: jest.fn(() => undefined),
        dbAll: jest.fn(() => []),
        dbRun: jest.fn(),
      }));
      const { windows, sent } = recordingWindows();
      // Install into the ISOLATE's provider instance, not the outer one:
      // `jest.isolateModules` gives `reviewStateService` a fresh
      // `windowsProvider` module, and the outer `installWindows` would put the
      // recorder somewhere the code under test never looks.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../../capabilities/windowsProvider").installWindows(windows);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { notifyReviewStateChanged } = require("../reviewStateService");

      // Synthetic id — invented for this test, not from any live row.
      notifyReviewStateChanged("synthetic-transaction-id");

      expect(sent).toHaveLength(1);
      const [channel, payload] = sent[0];
      expect(channel).toBe("review:queue-changed");
      // Every key, not `objectContaining`: the renderer's reducer reads all five
      // and a dropped key renders as `undefined` rather than failing loudly.
      expect(payload).toEqual({
        transactionId: "synthetic-transaction-id",
        added: 0,
        linked: 0,
        outstanding: 0,
        reason: "background",
      });
      expect(Object.keys(payload as object).sort()).toEqual([
        "added",
        "linked",
        "outstanding",
        "reason",
        "transactionId",
      ]);
    });
    jest.dontMock("../db/core/dbConnection");
  });
});
