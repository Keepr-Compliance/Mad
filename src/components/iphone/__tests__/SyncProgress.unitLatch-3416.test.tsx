/**
 * BACKLOG-3416 — the transferred-bytes unit is picked once, held for the sync,
 * and is never below MB.
 *
 * TWO REQUIREMENTS, and a test for each, because either one alone is satisfiable
 * without the other:
 *
 *   (1) the unit never changes mid-sync. It used to be recomputed from the
 *       current value on every render, so the founder watched "987.3 MB" become
 *       "1.0 GB" and the number appear to collapse to a hundredth of itself.
 *
 *   (2) the unit is MB or GB, never B or KB. His ask was "either only in MB or
 *       GB". This is NOT cosmetic: `bytesProcessed` comes from
 *       `electron/services/backupService.ts:1839`, which advances the counter only
 *       when a whole FILE completes, by that file's size. The first non-zero
 *       sample is therefore the first completed file — typically a few KB — so a
 *       latch without a floor pins a multi-gigabyte sync to KB and reads
 *       "6291456.0 KB". That satisfies (1) perfectly while missing the ask.
 *
 * WHAT EACH TEST DISCRIMINATES. A presence test ("it shows some bytes") passes
 * against the old code and carries no information. Each test below is aimed at a
 * specific wrong implementation, and each was shown red by a mutation that
 * reproduces exactly that implementation:
 *
 *   climb sweep         -> recompute-every-render (the shipped bug)
 *   small first sample  -> a latch with no MB floor (reads KB forever)
 *   zero does not latch -> a latch that fires on the first render regardless of
 *                          value, which pins a GB-scale sync to MB
 *   scaling at latch    -> latching the unit STRING while leaving the divisor
 *                          recomputed (a wrong number wearing the right label)
 *   remount resets      -> the next sync gets to pick its own unit
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
  it("never changes unit as the count climbs from 500 MiB past 1 GiB", () => {
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

  it("shows MB, never KB, when the first completed file is only a few KB", () => {
    // The realistic live shape: the counter advances a whole file at a time, and
    // the first one is small. Without the MB floor this whole sync reads in KB.
    const { rerender } = render(<SyncProgress progress={transferring(8 * KiB)} />);
    expect(displayedText()).toBe("0.0 MB");
    expect(displayedUnit()).toBe("MB");

    // It stays MB all the way up — no promotion to GB, no relapse to KB.
    for (const bytes of [900 * KiB, 5 * MiB, 500 * MiB, GiB, 6 * GiB]) {
      rerender(<SyncProgress progress={transferring(bytes)} />);
      expect(displayedUnit()).toBe("MB");
    }

    expect(displayedText()).toBe("6144.0 MB");
  });

  it("shows MB, not B, before any file has completed", () => {
    // `hasStartedTransfer` is true on processedFiles alone, so the readout can
    // render at 0 bytes. "0 B" would be a third unit on screen that then flips.
    render(<SyncProgress progress={{ ...transferring(0), bytesProcessed: 0 }} />);

    expect(displayedText()).toBe("0.0 MB");
  });

  it("does not latch on zero — a GB-scale first sample still gets GB", () => {
    // The MB floor makes a zero-latch indistinguishable on an ordinary sync, so
    // the case that still discriminates is a first completed file of 1 GiB or
    // more: latching before the first real sample would pin this to MB.
    const { rerender } = render(
      <SyncProgress progress={{ ...transferring(0), bytesProcessed: 0 }} />
    );
    expect(displayedText()).toBe("0.0 MB");

    rerender(<SyncProgress progress={transferring(2 * GiB)} />);
    expect(displayedText()).toBe("2.0 GB");
  });

  it("scales the NUMBER at the latched unit, not just the unit label", () => {
    // A latch that keeps the unit string but recomputes the divisor reads
    // "1.0 GB" here — a wrong number wearing the right label.
    const { rerender } = render(<SyncProgress progress={transferring(500 * MiB)} />);
    expect(displayedText()).toBe("500.0 MB");

    rerender(<SyncProgress progress={transferring(GiB)} />);
    expect(displayedText()).toBe("1024.0 MB");
  });

  it("resets on remount so the next sync picks its own unit", () => {
    const { unmount, rerender } = render(<SyncProgress progress={transferring(4 * MiB)} />);
    rerender(<SyncProgress progress={transferring(2 * GiB)} />);
    expect(displayedUnit()).toBe("MB");
    unmount();

    // The flow unmounts SyncProgress when it leaves the `progress` view, so a
    // later sync is a fresh mount and must not inherit the previous latch.
    render(<SyncProgress progress={transferring(2 * GiB)} />);
    expect(displayedText()).toBe("2.0 GB");
  });
});
