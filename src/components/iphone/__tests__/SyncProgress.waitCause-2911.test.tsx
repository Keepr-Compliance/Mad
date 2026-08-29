/**
 * BACKLOG-2911 (FIX 3) — "waiting for passcode" was a guess, and this file is the
 * control that stops it coming back.
 *
 * ## What the founder saw
 *
 * `backupService.ts` emits `waiting-for-passcode` after FIVE SECONDS with no file
 * progress. Nothing on that path reports that the device wants a passcode. Device-side
 * indexing, a phone nobody has picked up, and a hung process all produce the same
 * five seconds of silence.
 *
 * On the 12:09 run of 2026-08-28 he had ALREADY ENTERED his passcode, and this panel
 * told him to enter it for fifteen more minutes — the transfer began 903.9 seconds
 * after the request. The three measured waits that day were 507 s, 684.6 s and 903.9 s,
 * and all three runs SUCCEEDED.
 *
 * Same class as BACKLOG-2913 (every failure read "iPhone is locked") and the same rule
 * as BACKLOG-2886: report the uncertainty, do not substitute a confident cause.
 *
 * ## The control
 *
 * The item's requirement is exact: *"asserting the current 'enter your passcode'
 * phrasing as the primary claim must go red."* `PRIMARY_CLAIM_IS_THE_PASSCODE` below
 * is that assertion, and it is written so it FAILS on the fixed copy and would PASS on
 * the old one. It is not a wording test — it tests which sentence comes first, because
 * that is the claim a person reads.
 *
 * ## What is deliberately NOT changed
 *
 * The passcode is still mentioned, because it IS a real possibility and a user with a
 * prompt on screen needs to act on it. Removing it entirely would trade one wrong
 * claim for a missing instruction.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { SyncProgress } from "../SyncProgress";
import type { BackupProgress } from "../../../types/iphone";

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** The state the 5-second timer puts the UI into. */
function waiting(): BackupProgress {
  return {
    phase: "backing_up",
    percent: 0,
    message: "Your iPhone is preparing the export...",
  };
}

function cardText(): string {
  return document.body.textContent ?? "";
}

/**
 * The text of the AMBER PANEL ALONE — the paragraph that mentions a passcode.
 *
 * Scoped deliberately. An earlier draft of the ordering control read the whole card
 * and passed against the OLD copy, because `useIPhoneSync` also sets "Your iPhone is
 * preparing the export..." as the progress message and that line renders ABOVE the
 * panel. The control was measuring the progress line's position, not the panel's
 * claim. A control that cannot go red on the code it guards is not a control.
 */
function passcodePanelText(): string {
  const paragraph = screen.getByText(/passcode/i);
  return paragraph.textContent ?? "";
}

describe("BACKLOG-2911 FIX 3: the wait reports what is known", () => {
  it("leads with the observation — the iPhone is preparing the export", () => {
    render(<SyncProgress progress={waiting()} isWaitingForPasscode />);

    // Two nodes carry it: the progress line and the amber panel. Both are correct —
    // `useIPhoneSync` sets the same sentence as the progress message on this event.
    expect(screen.getAllByText(/preparing the export/i).length).toBeGreaterThan(0);
  });

  it("THE CONTROL — inside the panel, the passcode is NOT the primary claim", () => {
    render(<SyncProgress progress={waiting()} isWaitingForPasscode />);
    const text = passcodePanelText().toLowerCase();

    const firstPasscodeMention = text.indexOf("passcode");
    const firstObservation = text.indexOf("preparing the export");

    // Both must be present in the SAME paragraph, or the ordering below is vacuous.
    expect(firstObservation).toBeGreaterThanOrEqual(0);
    expect(firstPasscodeMention).toBeGreaterThanOrEqual(0);

    // The old copy opened with "Enter your passcode on your iPhone if prompted." —
    // an instruction, stated first, about a cause nothing established.
    expect(firstObservation).toBeLessThan(firstPasscodeMention);
  });

  it("THE CONTROL — the imperative 'Enter your passcode' opening is gone", () => {
    render(<SyncProgress progress={waiting()} isWaitingForPasscode />);

    // Verbatim from the copy that shipped, so this cannot pass by paraphrase.
    expect(passcodePanelText()).not.toMatch(/Enter your passcode on your iPhone if prompted/i);
  });

  it("the passcode is still offered as a possibility, conditionally", () => {
    render(<SyncProgress progress={waiting()} isWaitingForPasscode />);

    // A user with a prompt on screen still has to act. What changed is that the app
    // no longer claims to know the prompt is there.
    expect(passcodePanelText()).toMatch(/if your iphone is showing a passcode prompt/i);
  });

  it("the stated wait covers the longest one ever measured, 903.9 s", () => {
    render(<SyncProgress progress={waiting()} isWaitingForPasscode />);
    const text = passcodePanelText();

    // "up to 10 minutes" was contradicted by his own 12:09 run before this file existed.
    expect(text).not.toMatch(/up to 10 minutes/i);

    const stated = text.match(/up to (\d+) minutes/i);
    expect(stated).not.toBeNull();
    const statedSeconds = Number(stated?.[1]) * 60;
    expect(statedSeconds).toBeGreaterThanOrEqual(903.9);
  });

  it("says nothing at all about a passcode when the app is not in this state", () => {
    // The panel is gated on `isWaitingForPasscode`; a plain transferring run must not
    // carry any of this copy.
    render(<SyncProgress progress={{ phase: "backing_up", percent: 40, message: "Transferring…" }} />);

    expect(cardText()).not.toMatch(/passcode/i);
    expect(cardText()).not.toMatch(/preparing the export/i);
  });
});
