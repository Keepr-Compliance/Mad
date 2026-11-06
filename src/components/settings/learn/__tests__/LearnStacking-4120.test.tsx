/**
 * BACKLOG-4120 hotfix (2.46.1) — the Learn mode dialogs open ABOVE the
 * Settings page.
 *
 * Founder QA on v2.46.0: Settings › Help Keepr learn › Start "did nothing",
 * and the strip above the Settings page went gray. The question dialog is a
 * @keepr/ui Dialog, portaled to document.body at z-50; the Settings page is
 * SettingsLayer at z-[105] (src/constants/zLayers.ts). The dialog opened
 * behind the page, and only its full-window overlay showed in the strip the
 * page does not cover.
 *
 * jsdom has no layout, so stacking is read from what the components render:
 * for each element, the z-index class of its OUTERMOST z-classed ancestor
 * (itself included) — the z it competes with at the root. An element inside
 * the Settings layer would compete as the layer itself; the dialogs are
 * portaled to body, so they compete with their own z. Both the dialog panel
 * AND its overlay must sit above the Settings layer, below toasts.
 *
 * Real SettingsLayer; Settings itself is a stub that renders the real
 * LearnSettings section. window.api.learn is a fake main built from the
 * transcribed replies in learnFixtures-4120.ts.
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsLayer } from "../../../../appCore/shell/SettingsLayer";
import type { AppStateMachine } from "../../../../appCore/state/types";
import { Z_CLASS, zValue } from "../../../../constants/zLayers";
import type { LearnScoreResult } from "../../../../../electron/types/ipc/window-api-learn";
import { CLEANUP_NEXT, PREVIEW_CLEANUP, SCORE, STATE_ON } from "./learnFixtures-4120";

jest.mock("../../../../appCore/hooks/useEmailSettingsCallbacks", () => ({
  useEmailSettingsCallbacks: () => ({
    handleEmailConnectedFromSettings: jest.fn(),
    handleEmailDisconnectedFromSettings: jest.fn(),
  }),
}));

jest.mock("../../../Settings", () => {
  const { LearnSettings } = jest.requireActual("../LearnSettings");
  const { PlatformProvider } = jest.requireActual("@/contexts/PlatformContext");
  function StubSettings() {
    return (
      <PlatformProvider>
        <div data-testid="settings-page">
          <LearnSettings />
        </div>
      </PlatformProvider>
    );
  }
  return { __esModule: true, default: StubSettings };
});

function installFakeMain(): void {
  let answered = false;
  (window.api as unknown as { learn: unknown }).learn = {
    getState: jest.fn(async () => STATE_ON),
    setEnabled: jest.fn(async () => ({ success: true, enabled: true })),
    run: jest.fn(async () => ({ success: true, summary: { runId: "run-x", detectionIds: ["d1"], rowsScanned: 1 } })),
    onRunProgress: jest.fn(() => () => undefined),
    sampleDraw: jest.fn(async () => ({ success: true, result: { sampleSize: 0, drawn: 0 } })),
    score: jest.fn(async () => SCORE as Extract<LearnScoreResult, { success: true }>),
    cleanupNext: jest.fn(async () => ({
      success: true,
      question: answered ? null : (CLEANUP_NEXT as { question: unknown }).question,
    })),
    cleanupAnswer: jest.fn(async () => {
      answered = true;
      return { success: true };
    }),
    sampleNext: jest.fn(async () => ({ success: true, question: null })),
    sampleAnswer: jest.fn(async () => ({ success: true })),
    preview: jest.fn(async () => PREVIEW_CLEANUP),
    attachmentOpen: jest.fn(async () => ({ success: true, dataUrl: "data:application/pdf;base64,JVBERi0=", downloadedNow: true })),
    deleteAnswers: jest.fn(async () => ({ success: true, removed: { deal: 0, bulk: 0 } })),
  };
}

function makeApp(): AppStateMachine {
  return {
    modalState: { showSettings: true, settingsTarget: null },
    currentUser: { id: "user-4120", email: "user@example.invalid" },
    authProvider: "google",
    closeSettings: jest.fn(),
    clearSettingsTarget: jest.fn(),
    openAndroidSync: jest.fn(),
    openIPhoneSync: jest.fn(),
    handleLogout: jest.fn(),
  } as unknown as AppStateMachine;
}

function zClassOf(el: Element): number {
  const cls = Array.from(el.classList).filter((c) => /^z-(?:\[\d+\]|\d+)$/.test(c));
  // Two z classes on one element = which wins depends on stylesheet order, not on the code.
  if (cls.length > 1) throw new Error(`conflicting z-index classes: ${cls.join(" ")}`);
  return cls.length ? zValue(cls[0]) : NaN;
}

/** z of the outermost z-classed ancestor (self included): what `el` competes with at the root. */
function rootZ(el: Element): number {
  let z = NaN;
  for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
    const v = zClassOf(n);
    if (!Number.isNaN(v)) z = v;
  }
  return z;
}

/** The dialog's overlay: Radix renders it as a sibling of the panel in the same portal. */
function overlayOf(dialog: HTMLElement): HTMLElement {
  const parent = dialog.parentElement!;
  const overlay = Array.from(parent.children).find(
    (c) => c !== dialog && c.classList.contains("fixed") && c.classList.contains("inset-0"),
  ) as HTMLElement | undefined;
  if (!overlay) throw new Error("dialog overlay not found next to the dialog panel");
  return overlay;
}

function expectAboveSettings(dialog: HTMLElement): void {
  const layer = screen.getByTestId("settings-layer");
  const settingsZ = zClassOf(layer);
  expect(settingsZ).toBe(zValue(Z_CLASS.settings));
  // Portaled outside the Settings layer: it must win on its own z.
  expect(layer.contains(dialog)).toBe(false);
  for (const el of [dialog, overlayOf(dialog)]) {
    const z = rootZ(el);
    expect(z).toBeGreaterThan(settingsZ);
    expect(z).toBeLessThan(zValue(Z_CLASS.toast)); // a toast still shows over it
  }
}

beforeEach(() => {
  installFakeMain();
});

describe("Learn mode dialogs over the Settings page (BACKLOG-4120 2.46.1)", () => {
  it("Start opens the question dialog above the Settings layer (panel and overlay)", async () => {
    render(<SettingsLayer app={makeApp()} />);
    const start = await screen.findByTestId("learn-start");
    await waitFor(() => expect(start).not.toBeDisabled());
    fireEvent.click(start);
    const dialog = await screen.findByRole("dialog", { name: "Learn mode question" });
    expectAboveSettings(dialog);
  });

  it("the score shown after the last answer opens above the Settings layer", async () => {
    render(<SettingsLayer app={makeApp()} />);
    const start = await screen.findByTestId("learn-start");
    await waitFor(() => expect(start).not.toBeDisabled());
    fireEvent.click(start);
    const q = await screen.findByRole("dialog", { name: "Learn mode question" });
    const yes = await screen.findByRole("button", { name: /Yes, my deal/ });
    await waitFor(() => expect(yes).not.toBeDisabled());
    expect(q).toContainElement(yes);
    fireEvent.click(yes);
    const done = await screen.findByRole("dialog", { name: /Thanks, 1 answer saved/ });
    expectAboveSettings(done);
  });

  it("See score opens above the Settings layer", async () => {
    render(<SettingsLayer app={makeApp()} />);
    fireEvent.click(await screen.findByRole("button", { name: /See score/ }));
    const d = await screen.findByRole("dialog", { name: "How Keepr is doing" });
    expectAboveSettings(d);
  });
});
