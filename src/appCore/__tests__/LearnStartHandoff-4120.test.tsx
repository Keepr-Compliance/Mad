/**
 * BACKLOG-4120 hotfix (2.46.1) — Settings › Help Keepr learn › Start closes
 * Settings, then the Learn mode questions open over the main screen.
 *
 * Founder QA on v2.46.0: Start "did nothing" and the strip above the Settings
 * page went gray — the question dialog opened from inside the Settings page and
 * sat behind it. A first fix raised the dialog's z-index; jsdom passed it and
 * the real app did not change. This test therefore checks no z-index at all.
 * It checks the two things the founder's ordered fix guarantees:
 *   1. after Start, the Settings page is no longer rendered;
 *   2. the question dialog is rendered, outside any Settings tree, and keeps
 *      working (answer -> score) with Settings gone.
 *
 * Real useModalFlow, real SettingsLayer, real AppModals. Settings itself is a
 * stub that renders the real LearnSettings section with the prop Settings
 * passes. window.api.learn is a fake main from learnFixtures-4120.ts.
 */
import React, { useImperativeHandle, forwardRef } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsLayer } from "../shell/SettingsLayer";
import { AppModals } from "../AppModals";
import { useModalFlow } from "../state/flows/useModalFlow";
import type { AppStateMachine } from "../state/types";
import type { LearnScoreResult } from "../../../electron/types/ipc/window-api-learn";
import {
  CLEANUP_NEXT,
  LIST_ANSWERS,
  PREVIEW_CLEANUP,
  SCORE,
  STATE_ON,
} from "../../components/settings/learn/__tests__/learnFixtures-4120";

jest.mock("../../components/Settings", () => {
  const { LearnSettings } = jest.requireActual("../../components/settings/learn/LearnSettings");
  const { LearnAnswersPrivacyRow } = jest.requireActual("../../components/settings/learn/LearnAnswersPrivacyRow");
  const { PlatformProvider } = jest.requireActual("@/contexts/PlatformContext");
  function StubSettings(props: { onStartLearn?: (total: number) => void; onSeeLearnScore?: () => void }) {
    return (
      <PlatformProvider>
        <div data-testid="settings-page">
          <LearnSettings onStart={props.onStartLearn} onSeeScore={props.onSeeLearnScore} />
          <div id="settings-privacy">
            <LearnAnswersPrivacyRow />
          </div>
        </div>
      </PlatformProvider>
    );
  }
  return { __esModule: true, default: StubSettings };
});
jest.mock("../../components/TransactionList", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/Contacts", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/WelcomeTerms", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/AuditTransactionModal", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/MoveAppPrompt", () => ({ __esModule: true, default: () => null }));
jest.mock("../modals/IPhoneSyncModal", () => ({ IPhoneSyncModal: () => null }));
jest.mock("../modals/AndroidSyncModal", () => ({ AndroidSyncModal: () => null }));
jest.mock("../hooks/useEmailSettingsCallbacks", () => ({
  useEmailSettingsCallbacks: () => ({
    handleEmailConnectedFromSettings: jest.fn(),
    handleEmailDisconnectedFromSettings: jest.fn(),
  }),
}));
jest.mock("../hooks/useSubmissionStatusNotice", () => ({ useSubmissionStatusNotice: jest.fn() }));
jest.mock("../../hooks/useGoogleMessagesSyncStatus", () => ({ useGoogleMessagesSyncStatus: jest.fn() }));
jest.mock("../../hooks/useExtensionFolderRefresh", () => ({ useExtensionFolderRefresh: jest.fn() }));

let learnApi: Record<string, jest.Mock>;

function installFakeMain(): void {
  let answered = false;
  learnApi = {
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
    listAnswers: jest.fn(async () => ({ success: true, answers: [] })),
    deleteAnswer: jest.fn(async () => ({ success: true })),
  };
  (window.api as unknown as { learn: unknown }).learn = learnApi;
}

type Modal = ReturnType<typeof useModalFlow>;

/** The app's modal flow, the Settings page and the app modal layer, as App.tsx composes them. */
const Harness = forwardRef<Modal>(function Harness(_props, ref) {
  const modal = useModalFlow();
  useImperativeHandle(ref, () => modal, [modal]);
  const app = {
    currentStep: "dashboard",
    currentUser: { id: "user-4120", email: "user@example.invalid" },
    authProvider: "google",
    isDatabaseInitialized: true,
    appPath: "",
    ...modal,
  } as unknown as AppStateMachine;
  return (
    <div data-testid="app-root">
      <div data-testid="main-screen">Dashboard</div>
      <SettingsLayer app={app} />
      <AppModals app={app} />
    </div>
  );
});

function renderWithSettingsOpen(): void {
  const ref = React.createRef<Modal>();
  render(<Harness ref={ref} />);
  act(() => ref.current!.openSettings());
}

async function openSettingsAndStart(): Promise<HTMLElement> {
  renderWithSettingsOpen();
  const start = await screen.findByTestId("learn-start");
  await waitFor(() => expect(start).not.toBeDisabled());
  fireEvent.click(start);
  return screen.findByRole("dialog", { name: "Learn mode question" });
}

beforeEach(() => {
  installFakeMain();
});

describe("Help Keepr learn › Start and See score hand off to the main screen (BACKLOG-4120 2.46.1)", () => {
  it("Start closes Settings, then opens the question dialog outside any Settings tree", async () => {
    const dialog = await openSettingsAndStart();
    // 1. The Settings page is gone.
    expect(screen.queryByTestId("settings-layer")).toBeNull();
    expect(screen.queryByTestId("settings-page")).toBeNull();
    // 2. The dialog is rendered, and no Settings element is an ancestor of it.
    expect(dialog.closest('[data-testid="settings-layer"], [data-testid="settings-page"], #settings-learn')).toBeNull();
    expect(await within(dialog).findByText("4120 Canarytest Lane, Testville, ZZ 00000")).toBeInTheDocument();
    expect(learnApi.cleanupNext).toHaveBeenCalledTimes(1);
  });

  it("the sitting keeps working with Settings gone: an answer is saved and the score opens", async () => {
    const dialog = await openSettingsAndStart();
    const yes = await within(dialog).findByRole("button", { name: /Yes, my deal/ });
    await waitFor(() => expect(yes).not.toBeDisabled());
    fireEvent.click(yes);
    const done = await screen.findByRole("dialog", { name: "Thanks, 1 answer saved" });
    expect(learnApi.cleanupAnswer).toHaveBeenCalledWith({ detectionId: "d1", answer: "yes" });
    expect(screen.queryByTestId("settings-layer")).toBeNull();
    fireEvent.click(within(done).getByRole("button", { name: /done|close/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("See score closes Settings, then opens the score outside any Settings tree", async () => {
    renderWithSettingsOpen();
    fireEvent.click(await screen.findByRole("button", { name: /See score/ }));
    const d = await screen.findByRole("dialog", { name: "How Keepr is doing" });
    expect(screen.queryByTestId("settings-layer")).toBeNull();
    expect(screen.queryByTestId("settings-page")).toBeNull();
    expect(d.closest('[data-testid="settings-layer"], [data-testid="settings-page"], #settings-learn')).toBeNull();
    expect(within(d).getByTestId("learn-tile-found")).toBeInTheDocument();
  });
});

/**
 * C10 (2.46.2) — STRUCTURAL, not class strings: inside the real SettingsLayer,
 * a delete confirmation must render inside the row that asked, inside the
 * Settings layer, and no alertdialog may open. A confirmation dialog portals to
 * <body>, outside the Settings page, where it sits behind it (z-index alone
 * cannot be judged in jsdom). @keepr/ui is NOT mocked.
 */
describe("C10 delete confirmations stay inside the Settings page", () => {
  beforeEach(() => {
    learnApi.getState.mockImplementation(async () => ({ ...STATE_ON, answers: { deal: 1, bulk: 2 } }));
    learnApi.listAnswers.mockImplementation(async () => LIST_ANSWERS);
  });

  it("Your answers › Delete asks inside its row, inside the Settings layer", async () => {
    renderWithSettingsOpen();
    const layer = await screen.findByTestId("settings-layer");
    const box = await within(layer).findByTestId("learn-answers-list");
    const row = within(box).getAllByTestId("learn-answer-row")[0];
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    const confirmButton = within(row).getByRole("button", { name: "Delete" });
    expect(within(row).getByText("Delete?")).toBeInTheDocument();
    expect(layer.contains(confirmButton)).toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(confirmButton);
    await waitFor(() => expect(learnApi.deleteAnswer).toHaveBeenCalledWith({ kind: "deal", id: "dla-c" }));
  });

  it("Data & Privacy › Delete all asks inside its row, inside the Settings layer", async () => {
    renderWithSettingsOpen();
    const layer = await screen.findByTestId("settings-layer");
    const row = await within(layer).findByTestId("learn-answers-privacy");
    fireEvent.click(within(row).getByRole("button", { name: "Delete all" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const confirm = within(row).getByTestId("learn-delete-all-confirm");
    const confirmButton = within(confirm).getByRole("button", { name: "Delete all" });
    expect(layer.contains(confirmButton)).toBe(true);
    fireEvent.click(confirmButton);
    await waitFor(() => expect(learnApi.deleteAnswers).toHaveBeenCalledTimes(1));
  });

  it("Data & Privacy › Review opens Your answers inside the row", async () => {
    renderWithSettingsOpen();
    const layer = await screen.findByTestId("settings-layer");
    const row = await within(layer).findByTestId("learn-answers-privacy");
    fireEvent.click(within(row).getByRole("button", { name: "Review" }));
    const list = await within(row).findByTestId("learn-answers-list");
    expect(within(list).getAllByTestId("learn-answer-row")).toHaveLength(3);
  });
});

describe("C11 logout closes Learn mode", () => {
  it("an open sitting is closed, so it never reopens for the next user", async () => {
    const { renderHook } = await import("@testing-library/react");
    const { useLogoutHandler } = await import("../state/flows/auth/useLogoutHandler");
    const { result } = renderHook(() => {
      const modal = useModalFlow();
      const logout = useLogoutHandler({
        logout: async () => undefined,
        onCloseProfile: modal.closeProfile,
        onCloseLearn: modal.closeLearnSession,
        onSetHasSelectedPhoneType: () => undefined,
        onSetSelectedPhoneType: () => undefined,
        onSetCurrentStep: () => undefined,
        setIsNewUserFlow: () => undefined,
      });
      return { modal, logout };
    });
    act(() => result.current.modal.openLearnSession(30));
    expect(result.current.modal.modalState.learnOverlay).toEqual({ kind: "session", total: 30 });
    await act(async () => result.current.logout.handleLogout());
    expect(result.current.modal.modalState.learnOverlay).toBeNull();
  });
});
