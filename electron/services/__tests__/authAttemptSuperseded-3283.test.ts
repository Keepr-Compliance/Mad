/**
 * BACKLOG-3283 Path 3 — a replaced connect attempt ends; it does not hang.
 *
 * `startLocalServer()` closes a running callback server before starting a new
 * one. Before this fix it never settled the old attempt's `codePromise`, so the
 * old attempt's background task waited forever (Google) or, on Microsoft, woke
 * at its own 120 s race and pushed `{ success: false }` — which the NEWER
 * attempt's listener (per provider, not per attempt) read as its own failure.
 *
 * Real services, real loopback servers (the net guard allows loopback).
 */

import http from "http";

import { AuthAttemptSupersededError } from "../authAttemptSuperseded";
import googleAuthService from "../googleAuthService";
import microsoftAuthService from "../microsoftAuthService";

jest.mock("../databaseService");
jest.mock("axios");
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** GET a path on the attempt's loopback server; resolves when the response ends. */
function hit(port: number, pathAndQuery: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `localhost` + `agent: false`: same reasons as authCallbackPage.noDeepLink-3394.
    const req = http.get({ host: "localhost", port, path: pathAndQuery, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", reject);
  });
}

interface LocalServerService {
  startLocalServer(): { codePromise: Promise<string>; listeningPromise: Promise<number> };
  stopLocalServer(): void;
}

describe.each([
  ["Google", () => googleAuthService as unknown as LocalServerService],
  ["Microsoft", () => microsoftAuthService as unknown as LocalServerService],
])("BACKLOG-3283 Path 3: %s startLocalServer twice", (_provider, getService) => {
  afterEach(() => getService().stopLocalServer());

  it("rejects the first attempt's codePromise as superseded", async () => {
    const service = getService();
    const first = service.startLocalServer();
    await first.listeningPromise;
    // Attach before the rejection, as processLoginInBackground's await does.
    const firstOutcome = expect(first.codePromise).rejects.toBeInstanceOf(AuthAttemptSupersededError);

    const second = service.startLocalServer();
    await second.listeningPromise;
    second.codePromise.catch(() => undefined);

    await firstOutcome;
  });

  it("leaves the second attempt pending (it is not collateral)", async () => {
    const service = getService();
    const first = service.startLocalServer();
    await first.listeningPromise;
    first.codePromise.catch(() => undefined);

    const second = service.startLocalServer();
    await second.listeningPromise;

    const settled = await Promise.race([
      second.codePromise.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(settled).toBe("pending");
    second.codePromise.catch(() => undefined);
  });

  // SR 541eb8d3 change 1: the wrong build "reject codeRejecter inside
  // stopLocalServer()" turns every outcome into a supersede, because
  // stopLocalServer() runs before resolve/reject on each callback branch.
  it("a provider error on the callback rejects with that error, not as superseded", async () => {
    const service = getService();
    const attempt = service.startLocalServer();
    const port = await attempt.listeningPromise;
    const outcome = attempt.codePromise.then(
      () => null,
      (e: unknown) => e,
    );
    await hit(port, "/callback?error=access_denied&error_description=user_cancelled");
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AuthAttemptSupersededError);
    expect((error as Error).message).toContain("user_cancelled");
  });

  it("after a supersede, the newer attempt resolves its own code", async () => {
    const service = getService();
    const first = service.startLocalServer();
    await first.listeningPromise;
    first.codePromise.catch(() => undefined);
    const second = service.startLocalServer();
    const port = await second.listeningPromise;
    await hit(port, "/callback?code=abc");
    await expect(second.codePromise).resolves.toBe("abc");
  });

  // SR 541eb8d3 change 4: a supersede that lands before any consumer attached
  // must not raise unhandledRejection (main.ts forwards those to Sentry).
  it("rejecting a replaced attempt nobody awaits yet raises no unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const service = getService();
      const first = service.startLocalServer();
      await first.listeningPromise;
      // No consumer on first.codePromise.
      const second = service.startLocalServer();
      await second.listeningPromise;
      second.codePromise.catch(() => undefined);
      // Let the rejection propagate and Node's unhandled-rejection check run.
      await new Promise((resolve) => setTimeout(resolve, 20));
      // ...and it IS still a rejection for a consumer that attaches late.
      await expect(first.codePromise).rejects.toBeInstanceOf(AuthAttemptSupersededError);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
