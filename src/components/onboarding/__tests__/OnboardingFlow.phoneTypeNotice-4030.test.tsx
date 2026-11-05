/**
 * BACKLOG-4030 control C5: OnboardingFlow shows the "phone type not saved"
 * notice the app object carries, once, as an error toast, and then clears it.
 *
 * The notice is raised in useAppStateMachine, which runs above
 * NotificationProvider (App.tsx), so OnboardingFlow is the component that
 * shows it. Checked here:
 *   C5a a notice under a provider: notify.error once with the line, cleared.
 *   C5b no notice (a successful save): no toast of any kind.
 *   C5c no provider: renders, shows nothing, does not clear the notice.
 *   C5d StrictMode's double effect run still shows one toast.
 *
 * The state-machine / queue / selector layers are mocked out, as in
 * OnboardingFlow.driverCompletion.test.tsx, so only OnboardingFlow's own
 * notice effect is under test.
 */

import React from "react";
import { render } from "@testing-library/react";
import { OnboardingFlow } from "../OnboardingFlow";
import type { AppStateMachine } from "../../../appCore/state/types";
import { NotificationContext } from "../../../contexts/NotificationContext";
import { PHONE_TYPE_NOT_SAVED_NOTICE } from "../../../appCore/state/flows/usePhoneTypeApi";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ isWindows: false, isMacOS: true, isLinux: false, platform: "darwin" }),
}));

jest.mock("../../../appCore/state/machine", () => ({
  useOptionalMachineState: () => ({
    state: { status: "onboarding" },
    dispatch: jest.fn(),
  }),
}));

jest.mock("../../../appCore/state/machine/selectors", () => ({
  selectPhoneType: () => null,
  selectHasEmailConnectedNullable: () => false,
  selectHasPermissionsNullable: () => false,
  selectIsDatabaseInitialized: () => true,
}));

jest.mock("../../../appCore/state/machine/debug", () => ({
  logAllFlags: jest.fn(),
  logStateChange: jest.fn(),
}));

jest.mock("../queue/useOnboardingQueue", () => ({
  useOnboardingQueue: () => ({
    visibleEntries: [],
    activeEntry: undefined,
    activeStep: undefined,
    currentIndex: 0,
    isComplete: false,
    context: {},
    goToNext: jest.fn(),
    goToPrevious: jest.fn(),
    handleAction: jest.fn(),
    handleSkip: jest.fn(),
    isFirstStep: true,
    canSkip: false,
    isNextDisabled: false,
    isViewingPastStep: false,
  }),
}));

jest.mock("../shell/OnboardingShell", () => ({
  OnboardingShell: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="onboarding-shell">{children}</div>
  ),
}));
jest.mock("../shell/ProgressIndicator", () => ({ ProgressIndicator: () => null }));
jest.mock("../shell/NavigationButtons", () => ({ NavigationButtons: () => null }));

function makeApp(notice: string | null, clear: jest.Mock): AppStateMachine {
  return {
    selectedPhoneType: null,
    hasEmailConnected: false,
    currentUser: { id: "u1", email: "user@example.com" },
    pendingOnboardingData: null,
    hasPermissions: false,
    hasSecureStorageSetup: true,
    needsDriverSetup: false,
    needsTermsAcceptance: false,
    pendingOAuthData: null,
    authProvider: "google",
    isNewUserFlow: true,
    isDatabaseInitialized: true,
    phoneTypeSaveNotice: notice,
    clearPhoneTypeSaveNotice: clear,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeNotify() {
  return {
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
  };
}

function withProvider(notify: ReturnType<typeof makeNotify>, ui: React.ReactElement) {
  const value = { notify, notifications: [], dismiss: jest.fn(), dismissAll: jest.fn() };
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <NotificationContext.Provider value={value as any}>{ui}</NotificationContext.Provider>
  );
}

describe("BACKLOG-4030 C5: OnboardingFlow shows the phone-type save notice", () => {
  it("C5a shows the notice once as an error toast and clears it", () => {
    const notify = makeNotify();
    const clear = jest.fn();
    render(withProvider(notify, <OnboardingFlow app={makeApp(PHONE_TYPE_NOT_SAVED_NOTICE, clear)} />));

    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error).toHaveBeenCalledWith(PHONE_TYPE_NOT_SAVED_NOTICE);
    expect(notify.success).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("C5b shows no toast when there is no notice (a successful save)", () => {
    const notify = makeNotify();
    const clear = jest.fn();
    const { rerender } = render(withProvider(notify, <OnboardingFlow app={makeApp(null, clear)} />));
    rerender(withProvider(notify, <OnboardingFlow app={makeApp(null, clear)} />));

    expect(notify.error).not.toHaveBeenCalled();
    expect(notify.success).not.toHaveBeenCalled();
    expect(notify.info).not.toHaveBeenCalled();
    expect(notify.warning).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("C5c with no NotificationProvider it renders and leaves the notice in place", () => {
    const clear = jest.fn();
    expect(() =>
      render(<OnboardingFlow app={makeApp(PHONE_TYPE_NOT_SAVED_NOTICE, clear)} />),
    ).not.toThrow();
    expect(clear).not.toHaveBeenCalled();
  });

  it("C5d StrictMode's double effect run still shows one toast", () => {
    const notify = makeNotify();
    const clear = jest.fn();
    render(
      <React.StrictMode>
        {withProvider(notify, <OnboardingFlow app={makeApp(PHONE_TYPE_NOT_SAVED_NOTICE, clear)} />)}
      </React.StrictMode>,
    );

    expect(notify.error).toHaveBeenCalledTimes(1);
  });

  it("a second failure after the first was cleared shows a second toast", () => {
    const notify = makeNotify();
    const clear = jest.fn();
    const { rerender } = render(
      withProvider(notify, <OnboardingFlow app={makeApp(PHONE_TYPE_NOT_SAVED_NOTICE, clear)} />),
    );
    rerender(withProvider(notify, <OnboardingFlow app={makeApp(null, clear)} />));
    rerender(withProvider(notify, <OnboardingFlow app={makeApp(PHONE_TYPE_NOT_SAVED_NOTICE, clear)} />));

    expect(notify.error).toHaveBeenCalledTimes(2);
  });
});
