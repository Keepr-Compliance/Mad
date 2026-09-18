/**
 * BACKLOG-3416 — SyncProgress shows the transferred bytes in the unit the SYNC
 * decided, and never decides one itself.
 *
 * The decision (first non-zero sample, floored at MB, held for the whole sync)
 * is made by `useIPhoneSync` and carried on `progress.displayUnitIndex`; its
 * tests are in `hooks/__tests__/useIPhoneSync.test.ts`. It used to live in this
 * component, which unmounts when the modal is minimized — so reopening re-picked
 * the unit from the current count and one sync read "800.0 MB" then "1.5 GB".
 * That path is tested end to end in
 * `appCore/modals/__tests__/IPhoneSyncModal.unitAcrossReopen-3416.test.tsx`.
 *
 * What is left here is the display half, one test per wrong implementation:
 *
 *   climb at a given unit -> the component recomputing the unit from the count
 *                            (the shipped flip: "987.3 MB" became "1.0 GB")
 *   scaling at the unit   -> the unit LABEL honoured but the divisor recomputed
 *                            (a wrong number wearing the right label)
 *   zero before transfer  -> "0 B", a third unit on screen that then flips
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { SyncProgress } from "../SyncProgress";
import type { BackupProgress } from "../../../types/iphone";

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
const MB = 2;
const GB = 3;

function transferring(bytesProcessed: number, displayUnitIndex?: number): BackupProgress {
  return {
    phase: "backing_up",
    percent: 0,
    message: "Transferring…",
    bytesProcessed,
    processedFiles: 12,
    displayUnitIndex,
  };
}

/** The big transferred-bytes readout, e.g. "987.3 MB". */
function displayedText(): string {
  return screen.getByText(/^[\d,.]+ (B|KB|MB|GB)$/).textContent?.trim() ?? "";
}

describe("BACKLOG-3416: SyncProgress shows bytes in the sync's unit", () => {
  it("keeps the sync's unit as the count climbs past 1 GiB", () => {
    const { rerender } = render(<SyncProgress progress={transferring(500 * MiB, MB)} />);
    expect(displayedText()).toBe("500.0 MB");

    // Sweep the boundary rather than sampling either side of it.
    const climb: Array<[number, string]> = [
      [1023 * MiB, "1023.0 MB"],
      [GiB - 1, "1024.0 MB"], // last byte below the promotion threshold
      [GiB, "1024.0 MB"], // exactly the threshold — where the old code flipped
      [GiB + 1, "1024.0 MB"],
      [2 * GiB, "2048.0 MB"],
      [9 * GiB, "9216.0 MB"], // far past it
    ];

    for (const [bytes, expected] of climb) {
      rerender(<SyncProgress progress={transferring(bytes, MB)} />);
      expect(displayedText()).toBe(expected);
    }
  });

  it("scales the NUMBER at the given unit, not just the label", () => {
    const { rerender } = render(<SyncProgress progress={transferring(GiB, MB)} />);
    expect(displayedText()).toBe("1024.0 MB");

    // A different sync, decided at GB by a first completed file of 2 GiB.
    rerender(<SyncProgress progress={transferring(2 * GiB, GB)} />);
    expect(displayedText()).toBe("2.0 GB");
    rerender(<SyncProgress progress={transferring(2.5 * GiB, GB)} />);
    expect(displayedText()).toBe("2.5 GB");
  });

  it("shows 0.0 MB, not 0 B, before any bytes have moved", () => {
    // `hasStartedTransfer` is true on processedFiles alone, so the readout can
    // render at 0 bytes — before the hook has decided any unit.
    render(<SyncProgress progress={transferring(0)} />);

    expect(displayedText()).toBe("0.0 MB");
  });
});
