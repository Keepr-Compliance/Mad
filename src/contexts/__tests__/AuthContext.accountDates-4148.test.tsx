/**
 * BACKLOG-4148 — AuthContext's own session check (checkSession, on mount) keeps
 * created_at and last_login_at from auth:get-current-user. Before 4148 it copied
 * five fields and dropped both, so Account settings' "Member since" and
 * "Last login" rows never rendered (measured: currentUser keys were
 * avatar_url,display_name,email,id,terms_accepted_at).
 *
 * Fixture: handleGetCurrentUser's return; `user` is the local row
 * (`getUserByIdSync`: SELECT * FROM users_local). Harness from
 * AuthContext.provider-3956.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "../AuthContext";

const mockApi = { auth: { getCurrentUser: jest.fn(), logout: jest.fn(), acceptTerms: jest.fn() } };
beforeAll(() => {
  (window as unknown as { api: unknown }).api = mockApi;
});
afterAll(() => {
  delete (window as unknown as { api?: unknown }).api;
});

let seen: Record<string, unknown> | null = null;
function Probe() {
  const auth = useAuth();
  seen = auth.currentUser as unknown as Record<string, unknown> | null;
  return <span data-testid="loading">{String(auth.isLoading)}</span>;
}

it("C1 session check: currentUser keeps created_at and last_login_at", async () => {
  mockApi.auth.getCurrentUser.mockResolvedValue({
    success: true,
    user: {
      id: "u1",
      email: "user@example.com",
      display_name: "U",
      created_at: "2026-01-02 03:04:05",
      last_login_at: "2026-11-05 03:30:00",
    },
    sessionToken: "tok",
    provider: "google",
  });
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
  expect(seen).toEqual(
    expect.objectContaining({ created_at: "2026-01-02 03:04:05", last_login_at: "2026-11-05 03:30:00" }),
  );
});
