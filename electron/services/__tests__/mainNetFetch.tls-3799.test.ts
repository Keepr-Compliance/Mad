/**
 * @jest-environment node
 */
/**
 * BACKLOG-3799 — a TLS-inspecting antivirus re-signs every certificate with a
 * root that is in the OS store but not in Node's CA list. This suite builds
 * that situation locally: an HTTPS server whose certificate Node does not
 * trust, and a stand-in for Chromium's net.fetch that DOES trust it (as
 * Chromium trusts the OS store, where AVG installs its root).
 *
 * What it proves:
 *  T1  Node's own TLS rejects the certificate (fetch and https) — the bug.
 *  T2  With main-process axios installed on net.fetch, the Microsoft token
 *      refresh succeeds against that server, through the net.fetch stand-in.
 *  T3  The same call WITHOUT the routing fails with the certificate error, and
 *      the refresh-failure classifier calls it transient (not "expired").
 *
 * net.fetch itself cannot run under jest; the stand-in is a plain https client
 * given the test certificate as its CA. Certificate checking is ON everywhere.
 * Skipped when no `openssl` binary is available to mint the certificate.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import https from "https";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import axios from "axios";

const mockNetFetch = jest.fn();

jest.mock("electron", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const base = jest.requireActual("../../../tests/__mocks__/electron.js");
  return {
    ...base,
    app: { ...base.app, isReady: () => true, whenReady: () => Promise.resolve() },
    net: { ...(base.net ?? {}), fetch: (...args: unknown[]) => mockNetFetch(...args) },
  };
});
jest.mock("../databaseService");
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { installMainNetAxios } from "../mainNetFetch";
import microsoftAuthService from "../microsoftAuthService";
import { isTransientRefreshFailure } from "../oauthRefreshFailure";

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
const d = hasOpenssl ? describe : describe.skip;

d("BACKLOG-3799: certificate Node does not trust, trusted by the OS store", () => {
  let dir: string;
  let cert: Buffer;
  let server: https.Server;
  let base: string;
  let savedAdapter: unknown;
  let savedEnv: unknown;

  /** Stand-in for Chromium net.fetch: trusts `cert` the way Chromium trusts the OS store. */
  function osStoreFetch(url: string, init: RequestInit = {}): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: init.method ?? "GET",
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          ca: cert,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 0,
                headers: res.headers as Record<string, string>,
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      if (init.body) req.write(Buffer.from(init.body as Uint8Array));
      req.end();
    });
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3799-tls-"));
    const r = spawnSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", path.join(dir, "key.pem"),
        "-out", path.join(dir, "cert.pem"),
        "-days", "2",
        "-subj", "/CN=localhost/O=Keepr Test Interception Root",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
    cert = fs.readFileSync(path.join(dir, "cert.pem"));
    server = https.createServer(
      { key: fs.readFileSync(path.join(dir, "key.pem")), cert },
      (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "via-os-store", expires_in: 3600 }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `https://localhost:${(server.address() as AddressInfo).port}`;

    process.env.MICROSOFT_CLIENT_ID = "test-ms-client";
    savedAdapter = axios.defaults.adapter;
    savedEnv = axios.defaults.env;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
    axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
    axios.defaults.env = savedEnv as typeof axios.defaults.env;
    delete (process.versions as Record<string, string | undefined>).electron;
  });

  beforeEach(() => {
    mockNetFetch.mockReset();
    mockNetFetch.mockImplementation((url: string, init: RequestInit) => osStoreFetch(url, init));
    // Point the real service at the local server (its token URL is Microsoft's).
    (microsoftAuthService as unknown as { _ensureInitialized: () => void })._ensureInitialized();
    (microsoftAuthService as unknown as { tokenUrl: string }).tokenUrl = `${base}/token`;
  });

  it("T1 Node's own TLS rejects the certificate (global fetch and https)", async () => {
    const viaFetch = await fetch(`${base}/token`).catch((e: Error & { cause?: { code?: string } }) => e);
    expect((viaFetch as Error).message).toBe("fetch failed");
    expect((viaFetch as { cause?: { code?: string } }).cause?.code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY/);

    const viaHttps = await new Promise<NodeJS.ErrnoException>((resolve) => {
      https.get(`${base}/token`, () => resolve(new Error("unexpected success"))).on("error", resolve);
    });
    expect(viaHttps.code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY/);
  });

  it("T2 routed through net.fetch, the Microsoft token refresh succeeds", async () => {
    Object.defineProperty(process.versions, "electron", {
      value: "38.8.6",
      configurable: true,
      enumerable: true,
    });
    installMainNetAxios(axios);

    const tokens = await microsoftAuthService.refreshToken("rt");

    expect(tokens.access_token).toBe("via-os-store");
    expect(mockNetFetch).toHaveBeenCalledTimes(1);
    expect(String(mockNetFetch.mock.calls[0][0])).toBe(`${base}/token`);
  });

  it("T3 NOT routed (Node TLS), the refresh fails with the certificate error and is transient", async () => {
    axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
    axios.defaults.env = savedEnv as typeof axios.defaults.env;

    const err = await microsoftAuthService.refreshToken("rt").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(mockNetFetch).not.toHaveBeenCalled();
    const axiosErr = (err as { cause?: { code?: string; cause?: { code?: string } } }).cause;
    expect(axiosErr?.code ?? axiosErr?.cause?.code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY/);
    expect(isTransientRefreshFailure(err)).toBe(true);
  });
});
