/**
 * BACKLOG-4052: four CA roots leave Node's default trust store.
 *
 * Fingerprints here are computed independently of the production filter:
 * sha256 over the DER bytes, lower-case hex with no colons, against a
 * literal list written in that form. A filter that matches nothing (wrong
 * case, wrong separator, empty set) or removes too much fails the set checks.
 *
 * Fixture: the Electron 44.9.3 default store (Node 24.22.0, 121 roots), dumped with
 * tls.getCACertificates("default") under ELECTRON_RUN_AS_NODE. Re-dump it
 * when Electron's Node changes.
 */
import crypto from "crypto";
import fs from "fs";
import net from "net";
import path from "path";
import tls from "tls";
import ts from "typescript";
import {
  activeSocketHandles,
  applyNodeCaDenylist,
  filterRoots,
  NODE_CA_DENYLIST,
} from "../nodeCaDenylist";

const EXPECTED_REMOVED = new Set([
  "40f6af0346a99aa1cd1d555a4e9cce62c7f9634603ee406615833dc8c8d00367",
  "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b",
  "125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f",
  "bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3",
]);

const FIXTURE = path.join(__dirname, "fixtures", "node-ca-store-electron-44.9.3.pem");
const pems = (text: string): string[] =>
  text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
const fp = (pem: string): string =>
  crypto.createHash("sha256").update(new crypto.X509Certificate(pem).raw).digest("hex");
const fps = (list: readonly string[]): Set<string> => new Set(list.map(fp));
const minus = (a: Set<string>, b: Set<string>): Set<string> => new Set([...a].filter((x) => !b.has(x)));

describe("filterRoots on the Electron 44.9.3 store (C-1)", () => {
  const base = pems(fs.readFileSync(FIXTURE, "utf8"));
  const before = fps(base);

  it("the fixture is the full store and holds exactly the 4 denylisted roots", () => {
    expect(base).toHaveLength(121);
    expect([...before].filter((f) => EXPECTED_REMOVED.has(f)).sort()).toEqual([...EXPECTED_REMOVED].sort());
  });

  it("after == before minus exactly the 4 (set equality, nothing else removed)", () => {
    const { kept, removed } = filterRoots(base);
    expect(fps(kept)).toEqual(minus(before, EXPECTED_REMOVED));
    expect(fps(removed)).toEqual(EXPECTED_REMOVED);
    expect(kept).toHaveLength(117);
  });

  it("the production list names the same 4 roots", () => {
    const own = new Set([...NODE_CA_DENYLIST.keys()].map((k) => k.replace(/:/g, "").toLowerCase()));
    expect(own).toEqual(EXPECTED_REMOVED);
  });
});

describe("applyNodeCaDenylist on this thread's live store (C-1)", () => {
  const original = tls.getCACertificates("default");
  afterEach(() => tls.setDefaultCACertificates(original));

  it("replaces the default store with the store minus exactly the 4", () => {
    const denylisted = pems(fs.readFileSync(FIXTURE, "utf8")).filter((p) => EXPECTED_REMOVED.has(fp(p)));
    const seeded = [...original.filter((p) => !EXPECTED_REMOVED.has(fp(p))), ...denylisted];
    tls.setDefaultCACertificates(seeded);
    const before = fps(tls.getCACertificates("default"));
    expect([...before].filter((f) => EXPECTED_REMOVED.has(f))).toHaveLength(4);

    const r = applyNodeCaDenylist();

    expect(fps(tls.getCACertificates("default"))).toEqual(minus(before, EXPECTED_REMOVED));
    expect(r.before - r.after).toBe(4);
    expect(r.removedNames.sort()).toEqual(
      ["emSign ECC Root CA - C3", "emSign ECC Root CA - G3", "emSign Root CA - C1", "emSign Root CA - G1"],
    );
  });
});

describe("placement (C-5: the import order is the primary control)", () => {
  const importsOf = (file: string): string[] => {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    return sf.statements.filter(ts.isImportDeclaration).map((d) => (d.moduleSpecifier as ts.StringLiteral).text);
  };

  it("main.ts: installNodeCaDenylist is import #2, before installSentry and installMainNetAxios", () => {
    const specs = importsOf(path.resolve(__dirname, "../../main.ts"));
    const i = specs.indexOf("./bootstrap/installNodeCaDenylist");
    expect(specs[0]).toBe("./bootstrap/installAppDataPaths");
    expect(i).toBe(1);
    expect(i).toBeLessThan(specs.indexOf("./bootstrap/installSentry"));
    expect(i).toBeLessThan(specs.indexOf("./bootstrap/installMainNetAxios"));
  });

  it("C-3: each worker thread applies it as its first import (the store is per thread)", () => {
    expect(importsOf(path.resolve(__dirname, "../../services/atRest/sealWorker.ts"))[0]).toBe(
      "../../bootstrap/workerNodeCaDenylist",
    );
    expect(importsOf(path.resolve(__dirname, "../../workers/contactQueryWorker.ts"))[0]).toBe(
      "../bootstrap/workerNodeCaDenylist",
    );
  });
});

describe("activeSocketHandles (C-5)", () => {
  it("stdio pipes are expected; any socket or lookup handle is reported", () => {
    expect(activeSocketHandles(["PipeWrap", "PipeWrap", "Timeout"])).toEqual([]);
    expect(
      activeSocketHandles(["TCPSocketWrap", "TCPConnectWrap", "TLSWrap", "GetAddrInfoReqWrap", "PipeWrap"]),
    ).toEqual(["TCPSocketWrap", "TCPConnectWrap", "TLSWrap", "GetAddrInfoReqWrap"]);
  });

  it("sees a real open connection in this process", async () => {
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as net.AddressInfo;
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    expect(activeSocketHandles().length).toBeGreaterThan(0);
    sock.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("installNodeCaDenylist (fails open, reports, warns)", () => {
  const load = (mockApply: () => unknown, handles: string[]) => {
    const logMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    let failure: unknown = null;
    jest.isolateModules(() => {
      jest.doMock("electron-log", () => ({ __esModule: true, default: logMock }));
      jest.doMock("../nodeCaDenylist", () => ({
        activeSocketHandles: () => handles,
        applyNodeCaDenylist: mockApply,
        recordNodeCaDenylistFailure: (e: unknown) => { failure = e; },
      }));
      require("../installNodeCaDenylist");
    });
    return { logMock, failure: () => failure };
  };

  it("logs before -> after and the removed names", () => {
    const { logMock } = load(() => ({ before: 146, after: 142, removedNames: ["emSign Root CA - G1"] }), []);
    expect(logMock.info).toHaveBeenCalledWith("[NodeCaDenylist] node CA store 146 -> 142, removed: emSign Root CA - G1");
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("warns when a socket handle was already open", () => {
    const { logMock } = load(() => ({ before: 146, after: 142, removedNames: [] }), ["TCPSocketWrap"]);
    expect(logMock.warn).toHaveBeenCalledWith(expect.stringContaining("TCPSocketWrap"));
  });

  it("a throw is recorded for Sentry and logged, never rethrown", () => {
    const boom = new Error("no setDefaultCACertificates");
    const { logMock, failure } = load(() => { throw boom; }, []);
    expect(failure()).toBe(boom);
    expect(logMock.error).toHaveBeenCalled();
  });

  it("installSentry reports a recorded failure", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../installSentry.ts"), "utf8");
    expect(src).toMatch(/const caDenylistFailure = nodeCaDenylistFailure\(\);\s*if \(caDenylistFailure\) \{\s*Sentry\.captureException\(caDenylistFailure/);
  });
});
