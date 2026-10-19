/**
 * BACKLOG-3956 C1 — the deep-link login hands AuthContext "microsoft" for a
 * Microsoft sign-in, and keeps any other provider (e.g. "email") as-is.
 *
 * Fixture: "azure" is the raw Supabase value the deep-link callback carried
 * (electron/main.ts sent `user.app_metadata?.provider`).
 */
import { renderHook } from "@testing-library/react";
import { useLoginHandlers } from "../useLoginHandlers";
import type { DeepLinkAuthData } from "../../../../../components/Login";

jest.mock("../../../../../utils/logger", () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function setup() {
  const login = jest.fn();
  const { result } = renderHook(() =>
    useLoginHandlers({
      login,
      onSetCurrentStep: jest.fn(),
      setIsNewUserFlow: jest.fn(),
      setPendingOAuthData: jest.fn(),
    }),
  );
  return { login, handle: result.current.handleDeepLinkAuthSuccess };
}

function deepLink(provider: string | undefined): DeepLinkAuthData {
  return {
    accessToken: "at",
    refreshToken: "rt",
    userId: "u1",
    user: { id: "u1", email: "user@example.com", name: "User" },
    provider,
    isNewUser: true,
  } as DeepLinkAuthData;
}

describe("useLoginHandlers.handleDeepLinkAuthSuccess provider (BACKLOG-3956)", () => {
  it("C1: azure reaches login() as microsoft", () => {
    const { login, handle } = setup();
    handle(deepLink("azure"));
    expect(login).toHaveBeenCalledTimes(1);
    expect(login.mock.calls[0][2]).toBe("microsoft");
  });

  it("keeps an email sign-in as email (truthy — gates Profile/transactions)", () => {
    const { login, handle } = setup();
    handle(deepLink("email"));
    expect(login.mock.calls[0][2]).toBe("email");
  });

  it("keeps google as google", () => {
    const { login, handle } = setup();
    handle(deepLink("google"));
    expect(login.mock.calls[0][2]).toBe("google");
  });
});
