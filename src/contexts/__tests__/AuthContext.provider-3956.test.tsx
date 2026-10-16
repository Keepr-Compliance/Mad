/**
 * BACKLOG-3956 C8 — AuthContext maps "azure" to "microsoft" and keeps every
 * other provider as-is. An email sign-in must keep a truthy authProvider:
 * AppModals/AppShell show Profile, the transactions view and the health
 * monitor only when it is set.
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import { AuthProvider, useAuth } from "../AuthContext";

const mockApi = {
  auth: {
    getCurrentUser: jest.fn(),
    logout: jest.fn(),
    acceptTerms: jest.fn(),
  },
};

beforeAll(() => {
  (window as unknown as { api: unknown }).api = mockApi;
});
afterAll(() => {
  delete (window as unknown as { api?: unknown }).api;
});

let loginRef: ReturnType<typeof useAuth>["login"] | null = null;

function Probe() {
  const auth = useAuth();
  loginRef = auth.login;
  return (
    <>
      <span data-testid="loading">{String(auth.isLoading)}</span>
      <span data-testid="provider">{auth.authProvider === null ? "null" : auth.authProvider}</span>
    </>
  );
}

async function mount() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
}

describe("AuthContext provider (BACKLOG-3956)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loginRef = null;
  });

  it("C8: login with email keeps authProvider email (truthy)", async () => {
    mockApi.auth.getCurrentUser.mockResolvedValue({ success: false });
    await mount();
    act(() => {
      loginRef!({ id: "u1", email: "user@example.com" }, "tok", "email", undefined, true);
    });
    expect(screen.getByTestId("provider").textContent).toBe("email");
  });

  it("login with azure stores microsoft", async () => {
    mockApi.auth.getCurrentUser.mockResolvedValue({ success: false });
    await mount();
    act(() => {
      loginRef!({ id: "u1", email: "user@example.com" }, "tok", "azure", undefined, true);
    });
    expect(screen.getByTestId("provider").textContent).toBe("microsoft");
  });

  it("session restore with azure stores microsoft; email stays email", async () => {
    mockApi.auth.getCurrentUser.mockResolvedValue({
      success: true,
      user: { id: "u1", email: "user@example.com" },
      sessionToken: "tok",
      provider: "azure",
    });
    await mount();
    expect(screen.getByTestId("provider").textContent).toBe("microsoft");
  });

  it("session restore with email keeps email (C8, restore path)", async () => {
    mockApi.auth.getCurrentUser.mockResolvedValue({
      success: true,
      user: { id: "u1", email: "user@example.com" },
      sessionToken: "tok",
      provider: "email",
    });
    await mount();
    expect(screen.getByTestId("provider").textContent).toBe("email");
  });
});
