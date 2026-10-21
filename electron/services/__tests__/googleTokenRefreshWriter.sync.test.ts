/** @jest-environment node */
/**
 * BACKLOG-3306: persistRefreshedGoogleTokens must read the token reply before
 * anything else touches it. After emitting "tokens", google-auth-library
 * overwrites refresh_token on the same object, so a read after any await
 * would save the wrong value.
 */
const mockUpdate = jest.fn().mockResolvedValue(undefined);
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: { updateOAuthToken: (...a: unknown[]) => mockUpdate(...a) },
}));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn() },
}));

import {
  persistRefreshedGoogleTokens,
  type RefreshedGoogleTokens,
} from "../googleTokenRefreshWriter";

it("reads tokens synchronously: a mutation right after the call does not reach the write", async () => {
  const tokens: RefreshedGoogleTokens = {
    access_token: "A",
    refresh_token: "NEW",
    expiry_date: Date.now() + 3600e3,
  };
  const p = persistRefreshedGoogleTokens("id", tokens, "t");
  tokens.refresh_token = "OLD"; // what google-auth-library does after emit
  await p;
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  expect(mockUpdate.mock.calls[0][1].refresh_token).toBe("NEW");
});
