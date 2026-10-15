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
    ["tls.setDefaultCACertificates", /setDefaultCACertificates/],
    ["checkServerIdentity override", /checkServerIdentity\s*:/],
  ])("no %s in electron/ production code", (_label, re) => {
    expect(offenders(re)).toEqual([]);
  });
});

/** Inbound loopback servers (OAuth callback, local sync, RCS bridge). */
const HTTP_LOOPBACK_SERVERS = [
  "services/googleAuthService.ts",
  "services/microsoftAuthService.ts",
  "services/localSyncService.ts",
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
