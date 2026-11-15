/**
 * BACKLOG-4219 follow-up: the "Help improve Keepr" status line is current on
 * the same visit, with no remount.
 *
 * Main sends / withdraws in the background (learn:score fires maybeSend and
 * does not wait). Only a `learn:get-state { settle: true }` read waits for that
 * job, so in these tests a plain get-state NEVER carries the new value; only a
 * settled call does, and each settled call is held until the test releases it.
 *
 *   C-B1  after the score, "Last shared:" appears once the settled read returns
 *   C-B2  sharing OFF shows "Deleting…", which clears once the settled read says done
 *   C-B4  a settled read that returns after a newer switch change is dropped
 *   C-B4b same, when the switch change is followed by no re-read (score failed)
 *   C-B5  turning sharing ON sends right away: "Last shared:" appears on the same visit
 *
 * get-state replies are the handler's real shape (learnFixtures-4120 STATE_ON
 * plus the three pilot fields as learn:get-state returns them).
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PlatformProvider } from "@/contexts/PlatformContext";
import { LearnSettings } from "../LearnSettings";
import type { LearnStateResult } from "../../../../../electron/types/ipc/window-api-learn";
import { SCORE, STATE_ON } from "./learnFixtures-4120";

type State = Extract<LearnStateResult, { success: true }>;
type Held = { resolve: (s: LearnStateResult) => void };

const SENT_AT = "2026-11-13T17:30:15.000Z";
const on = (extra: Partial<State> = {}): LearnStateResult => ({ ...(STATE_ON as State), pilotReport: true, ...extra });
const off = (extra: Partial<State> = {}): LearnStateResult => ({ ...(STATE_ON as State), pilotReport: false, ...extra });

let plain: LearnStateResult;
let settled: Held[];
let api: Record<string, jest.Mock>;

function install(initial: LearnStateResult): void {
  plain = initial;
  settled = [];
  api = {
    getState: jest.fn((args?: { settle?: boolean }) => {
      if (args?.settle) return new Promise<LearnStateResult>((resolve) => settled.push({ resolve }));
      return Promise.resolve(plain);
    }),
    setEnabled: jest.fn(async ({ enabled }: { enabled: boolean }) => ({ success: true, enabled })),
    setPilotReport: jest.fn(async ({ enabled }: { enabled: boolean }) => ({
      success: true,
      pilotReport: enabled,
      pilotPending: !enabled,
    })),
    run: jest.fn(async () => ({ success: true, summary: { runId: "run-x", detectionIds: [], rowsScanned: 1 } })),
    onRunProgress: jest.fn(() => () => undefined),
    sampleDraw: jest.fn(async () => ({ success: true, result: { sampleSize: 0, drawn: 0 } })),
    score: jest.fn(async () => SCORE),
    listAnswers: jest.fn(async () => ({ success: true, answers: [] })),
    deleteAnswers: jest.fn(async () => ({ success: true, removed: { deal: 1, bulk: 0 } })),
  };
  (window.api as unknown as { learn: unknown }).learn = api;
}

function renderSettings() {
  return render(
    <PlatformProvider>
      <LearnSettings onStart={() => undefined} onSeeScore={() => undefined} />
    </PlatformProvider>,
  );
}

async function release(i: number, s: LearnStateResult): Promise<void> {
  await act(async () => {
    settled[i].resolve(s);
  });
}

const status = () => screen.queryByTestId("learn-pilot-status");
const pilotSwitch = () => screen.getByRole("switch", { name: "Help improve Keepr" });

describe("4219 the pilot status line is live on the same visit", () => {
  it("C-B1 after the score, 'Last shared:' appears once the settled read returns (no remount)", async () => {
    install(on());
    const { container } = renderSettings();
    await waitFor(() => expect(api.score).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(settled).toHaveLength(1));
    expect(status()).toBeNull();
    const before = container.firstChild;
    await release(0, on({ pilotLastSentAt: SENT_AT }));
    expect((await screen.findByTestId("learn-pilot-status")).textContent).toMatch(/^Last shared: /);
    expect(container.firstChild).toBe(before);
    // Every plain read said "never shared": only the settled read carried it.
    expect(api.getState.mock.calls.filter((c) => c[0] === undefined).length).toBeGreaterThan(0);
  });

  it("C-B2 sharing OFF shows 'Deleting…', which clears once the settled read says it is done", async () => {
    install(on({ pilotLastSentAt: SENT_AT }));
    renderSettings();
    await waitFor(() => expect(settled).toHaveLength(1));
    await release(0, on({ pilotLastSentAt: SENT_AT }));
    expect((await screen.findByTestId("learn-pilot-status")).textContent).toMatch(/^Last shared: /);

    fireEvent.click(pilotSwitch());
    await waitFor(() => expect(pilotSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(status()?.textContent).toMatch(/^Deleting… /);
    await waitFor(() => expect(settled).toHaveLength(2));
    await release(1, off({ pilotPending: false, pilotLastSentAt: null }));
    await waitFor(() => expect(status()).toBeNull());
    expect(pilotSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("C-B4 a settled read that returns after a newer switch change is dropped", async () => {
    install(on({ pilotLastSentAt: SENT_AT }));
    renderSettings();
    await waitFor(() => expect(settled).toHaveLength(1)); // held: from before the switch change

    await waitFor(() => expect(pilotSwitch()).not.toBeDisabled());
    fireEvent.click(pilotSwitch());
    await waitFor(() => expect(pilotSwitch()).toHaveAttribute("aria-checked", "false"));
    await waitFor(() => expect(settled).toHaveLength(2));

    await release(0, on({ pilotLastSentAt: SENT_AT })); // stale
    expect(pilotSwitch()).toHaveAttribute("aria-checked", "false");
    expect(status()?.textContent).toMatch(/^Deleting… /);

    await release(1, off({ pilotPending: true, pilotLastSentAt: null }));
    expect(pilotSwitch()).toHaveAttribute("aria-checked", "false");
    expect(status()?.textContent).toMatch(/^Deleting… /);
  });

  it("C-B4b a stale settled read is dropped after turning sharing ON with no re-read (score failed)", async () => {
    install(off());
    renderSettings();
    await waitFor(() => expect(settled).toHaveLength(1)); // held: from before the switch change
    api.score.mockResolvedValueOnce({ success: false, error: "Run the check first." });

    await waitFor(() => expect(pilotSwitch()).not.toBeDisabled());
    fireEvent.click(pilotSwitch());
    await waitFor(() => expect(api.score).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(pilotSwitch()).toHaveAttribute("aria-checked", "true"));
    expect(settled).toHaveLength(1);

    await release(0, off()); // stale
    expect(pilotSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("C-B5 turning sharing ON sends right away: 'Last shared:' appears on the same visit", async () => {
    install(off());
    renderSettings();
    await waitFor(() => expect(settled).toHaveLength(1));
    await release(0, off());
    expect(status()).toBeNull();

    await waitFor(() => expect(pilotSwitch()).not.toBeDisabled());
    fireEvent.click(pilotSwitch());
    await waitFor(() => expect(api.score).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(settled).toHaveLength(2));
    await release(1, on({ pilotLastSentAt: SENT_AT }));
    expect((await screen.findByTestId("learn-pilot-status")).textContent).toMatch(/^Last shared: /);
    expect(pilotSwitch()).toHaveAttribute("aria-checked", "true");
  });
});
