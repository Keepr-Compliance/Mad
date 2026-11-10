/**
 * BACKLOG-3302 keep-control. Removing the dead `pendingOAuthData` branches from
 * usePhoneHandlers leaves, in each phone-type handler, a LIVE fallback: when
 * `savePhoneType` reports `no-user` or `error` (database not ready yet), the
 * answer is held in `pendingOnboardingData` instead (BACKLOG-4030 result shape). The likely wrong cut deletes that fallback
 * along with the dead branch above it; nothing else in src/ goes red when it
 * does (measured: 524 suites green with the iPhone fallback write removed).
 *
 * Mutations: drop the fallback `setPendingOnboardingData` in any one handler
 * -> its test reds.
 */
import { act, renderHook } from "@testing-library/react";
import type { PendingOnboardingData } from "../../types";
import { usePhoneHandlers } from "../usePhoneHandlers";
import type { SavePhoneTypeResult } from "../usePhoneTypeApi";

type Updater = (prev: PendingOnboardingData) => PendingOnboardingData;

const PREV: PendingOnboardingData = {
  termsAccepted: false,
  phoneType: null,
  emailConnected: false,
  emailProvider: null,
};

function setup(saveResult: SavePhoneTypeResult) {
  const setPendingOnboardingData = jest.fn();
  const setSelectedPhoneType = jest.fn();
  const setHasSelectedPhoneType = jest.fn();
  const { result } = renderHook(() =>
    usePhoneHandlers({
      currentUserId: "user-1",
      isWindows: false,
      selectedPhoneType: null,
      setSelectedPhoneType,
      setHasSelectedPhoneType,
      setNeedsDriverSetup: jest.fn(),
      savePhoneType: jest.fn().mockResolvedValue(saveResult),
      setHasCompletedEmailOnboarding: jest.fn(),
      setPendingOnboardingData,
      setCurrentStep: jest.fn(),
    }),
  );
  const heldPhoneTypes = () =>
    setPendingOnboardingData.mock.calls.map(([u]) => (u as Updater)(PREV).phoneType);
  return { result, heldPhoneTypes, setSelectedPhoneType, setHasSelectedPhoneType };
}

describe("usePhoneHandlers holds the answer when the database is not ready (BACKLOG-3302)", () => {
  it("iPhone: save fails -> answer held as pending and selected", async () => {
    const t = setup({ status: "error" });
    await act(() => t.result.current.handleSelectIPhone());
    expect(t.heldPhoneTypes()).toEqual(["iphone"]);
    expect(t.setSelectedPhoneType).toHaveBeenCalledWith("iphone");
    expect(t.setHasSelectedPhoneType).not.toHaveBeenCalled();
  });

  it("Android: save fails -> answer held as pending", async () => {
    const t = setup({ status: "error" });
    await act(() => t.result.current.handleSelectAndroid());
    expect(t.heldPhoneTypes()).toEqual(["android"]);
  });

  it("Android continue-with-email: save fails -> answer held as pending", async () => {
    const t = setup({ status: "error" });
    await act(() => t.result.current.handleAndroidContinueWithEmail());
    expect(t.heldPhoneTypes()).toEqual(["android"]);
  });

  it("iPhone: no user yet -> answer held as pending", async () => {
    const t = setup({ status: "no-user" });
    await act(() => t.result.current.handleSelectIPhone());
    expect(t.heldPhoneTypes()).toEqual(["iphone"]);
  });

  it("save succeeds -> nothing held, the answer is recorded", async () => {
    const t = setup({ status: "saved" });
    await act(() => t.result.current.handleSelectIPhone());
    expect(t.heldPhoneTypes()).toEqual([]);
    expect(t.setHasSelectedPhoneType).toHaveBeenCalledWith(true);
  });
});
