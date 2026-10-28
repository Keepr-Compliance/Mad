/**
 * BACKLOG-4052: remove four CA roots from Node's default trust store.
 *
 * Pure module: imports only `tls` and `crypto`, so the main process, the
 * worker threads and the CI check (scripts/ci/check-node-ca-denylist.js) all
 * run the same code. The side effect lives in installNodeCaDenylist.ts (main)
 * and workerNodeCaDenylist.ts (workers): the default store is per thread.
 *
 * Roots are matched by exact SHA-256 fingerprint of the DER certificate, in
 * the upper-case colon form `X509Certificate.fingerprint256` returns.
 */
import crypto from "crypto";
import tls from "tls";

/** SHA-256 fingerprint -> subject CN, for the log line. */
export const NODE_CA_DENYLIST: ReadonlyMap<string, string> = new Map([
  ["40:F6:AF:03:46:A9:9A:A1:CD:1D:55:5A:4E:9C:CE:62:C7:F9:63:46:03:EE:40:66:15:83:3D:C8:C8:D0:03:67", "emSign Root CA - G1"],
  ["86:A1:EC:BA:08:9C:4A:8D:3B:BE:27:34:C6:12:BA:34:1D:81:3E:04:3C:F9:E8:A8:62:CD:5C:57:A3:6B:BE:6B", "emSign ECC Root CA - G3"],
  ["12:56:09:AA:30:1D:A0:A2:49:B9:7A:82:39:CB:6A:34:21:6F:44:DC:AC:9F:39:54:B1:42:92:F2:E8:C8:60:8F", "emSign Root CA - C1"],
  ["BC:4D:80:9B:15:18:9D:78:DB:3E:1D:8C:F4:F9:72:6A:79:5D:A1:64:3C:A5:F1:35:8E:1D:DB:0E:DC:0D:7E:B3", "emSign ECC Root CA - C3"],
]);

export interface FilterResult {
  kept: string[];
  removed: string[];
}

/** Splits `base` (PEM strings) into the roots kept and the denylisted ones removed. */
export function filterRoots(base: readonly string[], deny: ReadonlyMap<string, string> = NODE_CA_DENYLIST): FilterResult {
  const kept: string[] = [];
  const removed: string[] = [];
  for (const pem of base) {
    if (deny.has(new crypto.X509Certificate(pem).fingerprint256)) removed.push(pem);
    else kept.push(pem);
  }
  return { kept, removed };
}

export interface ApplyResult {
  before: number;
  after: number;
  removedNames: string[];
}

/** Replaces this thread's default CA store with the store minus the denylisted roots. */
export function applyNodeCaDenylist(deny: ReadonlyMap<string, string> = NODE_CA_DENYLIST): ApplyResult {
  const base = tls.getCACertificates("default");
  const { kept, removed } = filterRoots(base, deny);
  if (removed.length > 0) tls.setDefaultCACertificates(kept);
  return {
    before: base.length,
    after: tls.getCACertificates("default").length,
    removedNames: removed.map((pem) => deny.get(new crypto.X509Certificate(pem).fingerprint256) ?? "?"),
  };
}

/**
 * Handle types that mean a network connection or lookup already started.
 * The filter only governs connections opened after it, so any of these at
 * install time means something got there first. Pipes (stdio) are expected.
 */
const SOCKET_HANDLE = /TCP|TLS|UDP|GetAddrInfo|GetNameInfo|QueryReqWrap|HTTP|Socket/;

export function activeSocketHandles(resources: readonly string[] = process.getActiveResourcesInfo()): string[] {
  return resources.filter((r) => SOCKET_HANDLE.test(r));
}

/** Set by installNodeCaDenylist when the install threw; read by installSentry once Sentry is up. */
let installFailure: unknown = null;
export function recordNodeCaDenylistFailure(err: unknown): void {
  installFailure = err;
}
export function nodeCaDenylistFailure(): unknown {
  return installFailure;
}
