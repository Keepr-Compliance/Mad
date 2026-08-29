/**
 * BACKLOG-2956 — the local sync server must SAY what reached it.
 *
 * ## The failure this guards
 *
 * The founder's Android companion could not pair. Everything measurable said
 * the path was fine: the desktop was listening, it answered a local request in
 * 2 ms, the QR code was current, the firewall was off, the phone pinged the Mac
 * 3/3, and the phone's BROWSER reached the server (it got a TLS error against a
 * plaintext server — i.e. TCP connected). The desktop log recorded **nothing**
 * for any of it.
 *
 * Two reasons, both fixed here:
 *   - the only per-request line was `logService.debug`, and `logService`'s
 *     `minLevel` defaults to `"info"` — so it was dropped in every real run;
 *   - the unknown-route branch (what a browser hits) logged nothing at all.
 *
 * With no log, "the OS blocked the request before a socket was opened" and "the
 * request arrived and we refused it" look identical from the desktop side. That
 * is the distinction these tests protect. Assertions are on the LEVEL as much
 * as the text: a line logged at `debug` is a line nobody will ever read.
 *
 * These tests drive the REAL server over a real socket on an OS-assigned port,
 * the same harness style as localSyncService.identity.test.ts.
 */

import http from "http";

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({ auth: { getUser: jest.fn() } }),
  },
}));

import * as Sentry from "@sentry/electron/main";
import localSyncService from "../localSyncService";
import logService from "../logService";

const SECRET_B64 = Buffer.alloc(32, 9).toString("base64");

interface Resp {
  status: number;
  body: string;
}

/** Plain GET, i.e. exactly the shape a phone BROWSER sends. */
function get(host: string, port: number, path: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function post(
  host: string,
  port: number,
  path: string,
  bearer: string,
  body: unknown
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host,
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${bearer}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** All messages passed to a given logService level this test. */
const linesAt = (spy: jest.SpyInstance): string[] =>
  spy.mock.calls.map((c) => String(c[0]));

/**
 * The response "finish" handler runs on the SERVER's event loop turn, which can
 * land just after the client sees the last byte. Give it a couple of macrotask
 * turns to settle rather than racing it. (`setImmediate` is not available under
 * the jsdom test environment this suite runs in.)
 */
const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe("BACKLOG-2956: local sync server request observability", () => {
  let address: string;
  let port: number;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    infoSpy = jest.spyOn(logService, "info").mockResolvedValue(undefined);
    warnSpy = jest.spyOn(logService, "warn").mockResolvedValue(undefined);
    debugSpy = jest.spyOn(logService, "debug").mockResolvedValue(undefined);
    const bound = await localSyncService.startServer(0, SECRET_B64);
    address = bound.address;
    port = bound.port;
  });

  afterEach(async () => {
    await localSyncService.stopServer();
    jest.restoreAllMocks();
  });

  it("logs an arrival line at INFO for a request that hits no route (the browser case)", async () => {
    const res = await get(address, port, "/");
    await settle();
    expect(res.status).toBe(404);

    // At INFO, not debug: minLevel defaults to "info", so a debug line is
    // dropped and the request is invisible — the original bug.
    expect(linesAt(infoSpy)).toEqual(
      expect.arrayContaining([expect.stringContaining("--> GET /")])
    );
    expect(linesAt(debugSpy)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("GET /")])
    );
  });

  it("names the remote address, so 'nothing arrived' is distinguishable from 'we refused it'", async () => {
    await get(address, port, "/");
    await settle();
    const arrival = linesAt(infoSpy).find((l) => l.includes("--> GET /"));
    expect(arrival).toBeDefined();
    // Loopback in the test; a real phone's LAN IP in the field. Either way the
    // line must say WHO connected.
    expect(arrival).toMatch(/from \S+/);
  });

  it("logs the 404 with a REASON, not just a silent status", async () => {
    await get(address, port, "/some/unknown/path");
    await settle();
    expect(linesAt(warnSpy)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("No route for GET /some/unknown/path"),
      ])
    );
  });

  it("logs a completion line carrying the status code for every request", async () => {
    await get(address, port, "/ping");
    await settle();
    expect(linesAt(infoSpy)).toEqual(
      expect.arrayContaining([expect.stringContaining("<-- 200 GET /ping")])
    );

    await get(address, port, "/nope");
    await settle();
    expect(linesAt(warnSpy)).toEqual(
      expect.arrayContaining([expect.stringContaining("<-- 404 GET /nope")])
    );
  });

  it("sends a Sentry EVENT (not a breadcrumb) when a pairing request fails", async () => {
    // Wrong bearer -> 401. Breadcrumbs are discarded unless some other event is
    // captured in the same session (BACKLOG-2913 / 2950), which is why every
    // pairing failure so far left no trace in Sentry.
    const res = await post(address, port, "/register", "wrong-token", {
      deviceId: "d1",
    });
    await settle();
    expect(res.status).toBe(401);

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("Pairing request failed with 401"),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "register_failed" }),
      })
    );
    expect(Sentry.addBreadcrumb).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Pairing") })
    );
  });

  it("does NOT send a pairing-failure event when pairing is not what failed", async () => {
    // Asserting the event's ABSENCE on a non-/register 404 is what keeps the
    // signal meaningful — an event that fires for everything reports nothing.
    await get(address, port, "/");
    await settle();
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Pairing request failed"),
      expect.anything()
    );
  });

  it("never logs the bearer token or the request body", async () => {
    const SECRET_BODY = "TOP-SECRET-SMS-BODY-DO-NOT-LOG";
    await post(address, port, "/register", "bearer-token-should-not-appear", {
      deviceId: "d1",
      deviceName: SECRET_BODY,
    });
    await settle();

    const everything = [
      ...linesAt(infoSpy),
      ...linesAt(warnSpy),
      ...linesAt(debugSpy),
    ].join("\n");
    expect(everything).not.toContain("bearer-token-should-not-appear");
    expect(everything).not.toContain(SECRET_BODY);
  });
});
