/**
 * BACKLOG-3416 — the transferred-bytes unit is picked once and held for the sync.
 *
 * `bytesProcessed` climbs continuously and the display re-rendered on every
 * update, recomputing the unit from the current value each time. The founder
 * watched "987.3 MB" become "1.0 GB" mid-transfer: the unit changed under him
 * and the number appeared to collapse to a hundredth of what it had been.
 *
 * WHAT THESE TESTS DISCRIMINATE. A presence test ("it shows some bytes") passes
 * against the old code, so it carries no information. Each test below is aimed
 * at a specific wrong implementation:
 *
 *  1. the climb sweep      -> catches the shipped bug (recompute every render)
 *  2. zero must not latch  -> catches a latch that fires on the first render
 *                             regardless of value, pinning the sync to "B"
 *  3. scaling at the latch  -> catches latching the unit STRING while leaving the
 *                             divisor recomputed (that bug reads "1.0 KB" at 1 GiB)
 *  4. remount resets       -> the next sync gets to pick its own unit
 *
 * The boundary is swept, not sampled (CLAUDE.md, "Sweep boundaries"): the climb
 * crosses 1024^3 and keeps going, because one value per branch cannot catch a
 * unit that promotes one threshold late.
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

function transferring(bytesProcessed: number): BackupProgress {
  return {
    phase: "backing_up",
    percent: 0,
    message: "Transferring…",
    bytesProcessed,
    processedFiles: 12,
  };
}

/** The unit of the big transferred-bytes readout, e.g. "MB" from "987.3 MB". */
function displayedUnit(): string {
  const label = screen.getByText(/^[\d,.]+ (B|KB|MB|GB)$/);
  const unit = label.textContent?.trim().split(" ")[1];
  if (!unit) throw new Error(`no unit in ${JSON.stringify(label.textContent)}`);
  return unit;
}

function displayedText(): string {
  return screen.getByText(/^[\d,.]+ (B|KB|MB|GB)$/).textContent?.trim() ?? "";
}

describe("BACKLOG-3416: the byte unit is latched for the sync", () => {
  it("never changes unit as the count climbs from 500 KiB past 1 GiB", () => {
    // Latches at MB: 500 KiB would be KB, so start the sync where the founder's
    // did — already in MB — and climb across the GiB boundary and beyond.
    const { rerender } = render(<SyncProgress progress={transferring(500 * MiB)} />);
    const latched = displayedUnit();
    expect(latched).toBe("MB");

    // Sweep the boundary rather than sampling either side of it.
    const climb = [
      700 * MiB,
      1000 * MiB,
      1023 * MiB,
      GiB - 1, // last byte below the promotion threshold
      GiB, // exactly the threshold — where the old code flipped
      GiB + 1,
      2 * GiB,
      9 * GiB, // far past it: a second latch would have promoted again by now
    ];

    for (const bytes of climb) {
      rerender(<SyncProgress progress={transferring(bytes)} />);
      expect(displayedUnit()).toBe(latched);
    }

    // And the number keeps growing in the latched unit — it does not collapse.
    expect(displayedText()).toBe("9216.0 MB");
  });

  it("does not latch on zero — a sync showing '0 B' still picks its unit from the first real count", () => {
    // `hasStartedTransfer` is true on processedFiles alone, so the readout renders
    // at 0 bytes. Latching there would pin the whole transfer to "B".
    const { rerender } = render(
      <SyncProgress progress={{ ...transferring(0), bytesProcessed: 0 }} />
    );
    expect(displayedText()).toBe("0 B");

    rerender(<SyncProgress progress={transferring(5 * MiB)} />);
    expect(displayedText()).toBe("5.0 MB");
  });

  it("scales the NUMBER at the latched unit, not just the unit label", () => {
    // A latch that keeps the unit string but recomputes the divisor reads
    // "1.0 KB" here — a wrong number wearing the right label.
    const { rerender } = render(<SyncProgress progress={transferring(500 * KiB)} />);
    expect(displayedText()).toBe("500.0 KB");

    rerender(<SyncProgress progress={transferring(GiB)} />);
    expect(displayedText()).toBe("1048576.0 KB");
  });

  it("resets on remount so the next sync picks its own unit", () => {
    const { unmount, rerender } = render(<SyncProgress progress={transferring(500 * KiB)} />);
    rerender(<SyncProgress progress={transferring(2 * GiB)} />);
    expect(displayedUnit()).toBe("KB");
    unmount();

    // The flow unmounts SyncProgress when it leaves the `progress` view, so a
    // later sync is a fresh mount and must not inherit the previous latch.
    render(<SyncProgress progress={transferring(2 * GiB)} />);
    expect(displayedText()).toBe("2.0 GB");
  });
});
