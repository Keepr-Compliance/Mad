/**
 * @jest-environment node
 */
/**
 * BACKLOG-3799 — guards on main-process TLS / HTTP transport.
 *
 *  G1  Certificate checking is never weakened in electron/ production code:
 *      no `rejectUnauthorized: false`, no NODE_TLS_REJECT_UNAUTHORIZED, no
 *      NODE_EXTRA_CA_CERTS-based fix (packaged Electron ignores that variable,
 *      and the fix is the OS store via net.fetch), no custom verify procs.
 *  G2  No main-process module opens an outbound connection on Node's TLS:
 *      `https`, `node-fetch` and `undici` are not imported; `http` only by the
 *      loopback servers listed below; no per-call axios `adapter:` override;
 *      every googleapis OAuth2 client passes `transporterOptions`.
 *  G3  main.ts installs the axios transport before any handler module, and
 *      the bootstrap really does point axios at net.fetch.
 *  G4  BACKLOG-3969: no server listens beyond this machine. Every `.listen(`
 *      in electron/ production code passes "localhost" or RCS_BRIDGE_HOST
 *      (which must be "127.0.0.1") as its host. A `.listen(port)` with no host
 *      binds every interface and fails. (The Android companion's LAN server,
 *      which bound the machine's LAN address, is removed.)
 *
 * Sources are read as text; a file with a raw NUL byte would still be read.
 */

import fs from "fs";
import path from "path";

const ELECTRON_DIR = path.join(__dirname, "..", "..");

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__mocks__" || entry.name === "node_modules") continue;
      out.push(...productionFiles(full));
    } else if (/\.(ts|js)$/.test(entry.name) && !/\.(test|spec)\.(ts|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const FILES = productionFiles(ELECTRON_DIR).map((f) => ({
  rel: path.relative(ELECTRON_DIR, f).split(path.sep).join("/"),
  text: fs.readFileSync(f, "utf8"),
}));

/** Code with line and block comments removed (good enough for these patterns). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function offenders(re: RegExp, allow: readonly string[] = []): string[] {
  return FILES.filter((f) => !allow.includes(f.rel) && re.test(code(f.text))).map((f) => f.rel);
}

describe("G0 the scan sees the tree", () => {
  it("reads a non-trivial number of production files, including the known clients", () => {
    expect(FILES.length).toBeGreaterThan(200);
    const rels = FILES.map((f) => f.rel);
    for (const known of [
      "main.ts",
      "services/microsoftAuthService.ts",
      "services/outlookFetchService.ts",
      "services/gmailFetchService.ts",
      "services/mainNetFetch.ts",
    ]) {
      expect(rels).toContain(known);
    }
  });
});

describe("G1 certificate checking is never weakened", () => {
  it.each([
    ["rejectUnauthorized: false", /rejectUnauthorized\s*:\s*(false|0)\b/],
    ["NODE_TLS_REJECT_UNAUTHORIZED", /NODE_TLS_REJECT_UNAUTHORIZED/],
    ["NODE_EXTRA_CA_CERTS", /NODE_EXTRA_CA_CERTS/],
    ["setCertificateVerifyProc", /setCertificateVerifyProc/],
    ["checkServerIdentity override", /checkServerIdentity\s*:/],
  ])("no %s in electron/ production code", (_label, re) => {
    expect(offenders(re)).toEqual([]);
  });

  // BACKLOG-4052: the one allowed caller only REMOVES roots: it sets the store
  // to the current default store minus denylisted entries. That it removes
  // exactly those and nothing else is proven in nodeCaDenylist-4052.test.ts.
  it("tls.setDefaultCACertificates only in bootstrap/nodeCaDenylist.ts, and only to a filtered copy of the default store", () => {
    expect(offenders(/setDefaultCACertificates/, ["bootstrap/nodeCaDenylist.ts"])).toEqual([]);
    const own = FILES.find((f) => f.rel === "bootstrap/nodeCaDenylist.ts");
    expect(own).toBeDefined();
    const text = code(own!.text);
    expect(text.match(/setDefaultCACertificates\(/g)).toHaveLength(1);
    expect(text).toContain("tls.setDefaultCACertificates(kept)");
    expect(text).toMatch(/const base = tls\.getCACertificates\("default"\);\s*const \{ kept, removed \} = filterRoots\(base, deny\);/);
  });
});

/** Inbound loopback servers (OAuth callback, RCS bridge). */
const HTTP_LOOPBACK_SERVERS = [
  "services/googleAuthService.ts",
  "services/microsoftAuthService.ts",
  "services/rcsExtensionBridge.ts",
];

describe("G2 no outbound client on Node's TLS", () => {
  it("nothing imports https / node-fetch / undici", () => {
    expect(
      offenders(/(from\s+["'](node:)?https["'])|(require\(\s*["'](node:)?https["']\s*\))|(["'](node-fetch|undici)["'])/),
    ).toEqual([]);
  });

  it("only the loopback servers import http", () => {
    expect(
      offenders(/(from\s+["'](node:)?http["'])|(require\(\s*["'](node:)?http["']\s*\))/, HTTP_LOOPBACK_SERVERS),
    ).toEqual([]);
  });

  it("no axios call overrides the adapter", () => {
    expect(offenders(/\badapter\s*:/)).toEqual([]);
  });

  it("every googleapis OAuth2 client is built with transporterOptions", () => {
    const missing: string[] = [];
    for (const f of FILES) {
      const c = code(f.text);
      const re = /new\s+google\.auth\.OAuth2\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(c))) {
        const call = c.slice(m.index, c.indexOf(");", m.index) + 2);
        if (!/transporterOptions\s*:\s*\{\s*fetchImplementation\s*:\s*gaxiosNetFetch/.test(call)) {
          missing.push(f.rel);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

/** The argument list of the call whose "(" is at `open`, split on top-level commas. */
function callArgs(c: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < c.length; i++) {
    const ch = c[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(c.slice(start, i).trim());
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push(c.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error("unterminated .listen( call");
}

/** Every `.listen(` call in production code, with its host argument (multi-line safe). */
function listenCalls(): Array<{ rel: string; host: string | undefined }> {
  const out: Array<{ rel: string; host: string | undefined }> = [];
  for (const f of FILES) {
    const c = code(f.text);
    const re = /\.listen\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(c))) {
      const args = callArgs(c, m.index + m[0].length - 1);
      out.push({ rel: f.rel, host: args[1] });
    }
  }
  return out;
}

const LOOPBACK_HOSTS = ['"localhost"', "'localhost'", "RCS_BRIDGE_HOST"];

describe("G4 no server listens beyond this machine (BACKLOG-3969)", () => {
  it("finds the known listeners (the scan is not vacuous)", () => {
    expect([...new Set(listenCalls().map((l) => l.rel))].sort()).toEqual([
      "services/googleAuthService.ts",
      "services/microsoftAuthService.ts",
      "services/rcsExtensionBridge.ts",
    ]);
  });

  it("every .listen( passes a loopback host", () => {
    const offending = listenCalls()
      .filter((l) => l.host === undefined || !LOOPBACK_HOSTS.includes(l.host))
      .map((l) => `${l.rel}: host=${l.host ?? "(none: every interface)"}`);
    expect(offending).toEqual([]);
  });

  it('RCS_BRIDGE_HOST is "127.0.0.1"', () => {
    const bridge = FILES.find((f) => f.rel === "services/rcsExtensionBridge.ts")!.text;
    expect(bridge).toMatch(/export const RCS_BRIDGE_HOST = "127\.0\.0\.1";/);
  });
});

describe("G3 main.ts installs the axios transport", () => {
  it("imports the bootstrap before the first handler module", () => {
    const main = FILES.find((f) => f.rel === "main.ts")!.text;
    const install = main.indexOf('import "./bootstrap/installMainNetAxios";');
    const firstHandler = main.search(/from\s+"\.\/handlers\//);
    expect(install).toBeGreaterThan(-1);
    expect(firstHandler).toBeGreaterThan(-1);
    expect(install).toBeLessThan(firstHandler);
  });

  it("the bootstrap points the default axios at net.fetch", () => {
    jest.isolateModules(() => {
      // A fresh module registry: this axios has never been configured.
      /* eslint-disable @typescript-eslint/no-require-imports */
      const freshAxios = require("axios").default ?? require("axios");
      expect(freshAxios.defaults.adapter).not.toBe("fetch");
      require("../../bootstrap/installMainNetAxios");
      const { axiosNetFetch } = require("../mainNetFetch");
      /* eslint-enable @typescript-eslint/no-require-imports */
      expect(freshAxios.defaults.adapter).toBe("fetch");
      expect(freshAxios.defaults.env?.fetch).toBe(axiosNetFetch);
    });
  });
});
