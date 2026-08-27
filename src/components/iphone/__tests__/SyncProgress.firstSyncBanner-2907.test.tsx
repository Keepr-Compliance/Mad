/**
 * BACKLOG-2907 — the first-sync banner, and the two spinners removed alongside it.
 *
 * The banner said "First sync may take up to two hours…" on EVERY sync that had
 * started transferring bytes, because its predicate had no first-sync condition:
 *
 *   const showFirstSyncHint = !isComplete && !isError && isBackingUp && hasStartedTransfer;
 *
 * The founder saw it on a run where the backend had already logged
 * `Previous backup did not finish (6.5 GB on disk)`.
 *
 * The signal now plumbed through `BackupProgress.priorBackup` has THREE states, and
 * the banner is allowed to render in exactly one of them. The other two — a prior
 * backup exists, and "could not establish" — both render nothing. A presence-only
 * test would have passed against the OLD code, since the banner always rendered; the
 * tests that carry information here are the ABSENCE ones.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { SyncProgress } from "../SyncProgress";
import type { BackupProgress } from "../../../types/iphone";

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** The copy the founder actually saw. Matched loosely so wording tweaks do not break it. */
const BANNER = /First sync/i;
const BANNER_BODY = /may take up to two hours/i;

/**
 * A sync that has started transferring bytes — i.e. every other clause of the
 * predicate is satisfied, so `priorBackup` is the only thing under test.
 */
function transferring(priorBackup?: BackupProgress["priorBackup"]): BackupProgress {
  return {
    phase: "backing_up",
    percent: 12,
    message: "Transferring…",
    bytesProcessed: 1024 * 1024 * 512,
    processedFiles: 4210,
    ...(priorBackup ? { priorBackup } : {}),
  };
}

describe("BACKLOG-2907: the banner renders only on an established full transfer", () => {
  it("renders when the host established no usable prior backup exists", () => {
    render(<SyncProgress progress={transferring("none")} />);

    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.getByText(BANNER_BODY, { exact: false })).toBeInTheDocument();
  });

  it("BACKLOG-2938 — renders on the founder's unusable directory, which now maps to `none`", () => {
    // His `Backups/<udid>/` holds a 6.3 MB `Info.plist` and no manifest. Under the
    // OLD contract that directory's mere existence mapped to `"exists"`, so he was
    // told "Previous backup can't be used. Starting a fresh backup…" and, in the same
    // run, NOT told the replacement is a multi-hour full transfer.
    //
    // `PriorBackupState` now reports USABILITY, so that state arrives here as
    // `"none"`. The orchestrator half of this control — that his exact
    // `checkBackupStatus` shape produces `"none"` — is in
    // `deviceSyncOrchestrator.usabilityParity-2938.test.ts`; this is the renderer half.
    render(<SyncProgress progress={transferring("none")} />);

    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.getByText(BANNER_BODY, { exact: false })).toBeInTheDocument();
  });

  it("does NOT render when a USABLE prior backup exists — the sync is incremental", () => {
    // BACKLOG-2938 narrowed what reaches `"exists"`: a complete, uninterrupted prior
    // backup, and nothing else. The absence asserted here is what stops the fix from
    // becoming "always show", which was BACKLOG-2907's original defect.
    render(<SyncProgress progress={transferring("exists")} />);

    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
    expect(screen.queryByText(BANNER_BODY, { exact: false })).not.toBeInTheDocument();
  });

  it("does NOT render when the answer could not be established", () => {
    // The rule this item is built on: when the answer is unknown, render nothing.
    // Claiming a two-hour first sync on a guess is the defect in a new hat.
    render(<SyncProgress progress={transferring("unknown")} />);

    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it("does NOT render when the payload carries no signal at all", () => {
    // A main process that predates this field. Absent must read as "unknown",
    // never as "first sync" — otherwise every stale payload reintroduces the bug.
    render(<SyncProgress progress={transferring()} />);

    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });
});

describe("BACKLOG-2907: the other predicate clauses still gate the banner", () => {
  it("does not render before any bytes have moved, even on an established first sync", () => {
    render(
      <SyncProgress
        progress={{ phase: "backing_up", percent: 0, message: "Starting…", priorBackup: "none" }}
      />,
    );

    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it("does not render once the sync is complete", () => {
    render(
      <SyncProgress progress={{ ...transferring("none"), phase: "complete", percent: 100 }} />,
    );

    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it("does not render in the error state", () => {
    render(<SyncProgress progress={{ ...transferring("none"), phase: "error" }} />);

    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });
});

describe("BACKLOG-2907: the purple spinner is gone", () => {
  it("renders no spinner in the default in-progress state", () => {
    const { container } = render(<SyncProgress progress={transferring("exists")} />);

    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.querySelector(".bg-purple-100")).toBeNull();
    expect(container.querySelector(".border-purple-500")).toBeNull();
  });

  it("leaves no empty icon wrapper behind in the default state", () => {
    const { container } = render(<SyncProgress progress={transferring("exists")} />);

    // The wrapper carries `mb-4`. Kept for the complete/error/passcode icons, but an
    // empty one would push the title down by its own margin for no reason.
    expect(container.querySelector(".justify-center.mb-4")).toBeNull();
  });

  it("still renders the surrounding layout: title, transferred bytes, keep-connected notice", () => {
    render(<SyncProgress progress={transferring("exists")} />);

    expect(screen.getByText("Exporting - Keep connected")).toBeInTheDocument();
    expect(screen.getByText("512.0 MB")).toBeInTheDocument();
    expect(screen.getByText(/keep your iPhone connected/i)).toBeInTheDocument();
  });

  it("still renders the complete, error and passcode icons in their own states", () => {
    // The wrapper is load-bearing for these three. Removing the spinner must not
    // take them with it.
    const complete = render(
      <SyncProgress progress={{ phase: "complete", percent: 100 }} />,
    );
    expect(complete.container.querySelector(".bg-green-100")).not.toBeNull();
    complete.unmount();

    const errored = render(<SyncProgress progress={{ phase: "error", percent: 0 }} />);
    expect(errored.container.querySelector(".bg-red-100")).not.toBeNull();
    errored.unmount();

    const passcode = render(
      <SyncProgress progress={transferring("exists")} isWaitingForPasscode />,
    );
    expect(passcode.container.querySelector(".bg-amber-100")).not.toBeNull();
  });
});
