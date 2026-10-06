/**
 * BACKLOG-3666 test helpers: a paired service worker. Installs the real
 * protocol (globalThis.KeeprPair) and an in-memory key store holding a
 * NON-extractable HMAC key, and signs stubbed bridge replies the way Keepr
 * does, so worker tests can exercise job calls.
 */
import { webcrypto } from "crypto";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
export const P = require("../../../chrome-extension/pair-protocol.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

export const TEST_PAIR_ID = "p-test";
export const TEST_KEY_HEX = "11".repeat(32);

type Pairing = { pairId: string; key: CryptoKey } | null;

/** Install (paired = true) or clear the worker's pairing globals. Returns the store's state. */
export async function installPairing(paired: boolean): Promise<{ current: Pairing }> {
  const g = globalThis as Record<string, unknown>;
  // jsdom has no crypto.subtle: the worker signs with WebCrypto, as Chrome does.
  const c = g.crypto as { subtle?: unknown } | undefined;
  if (!c || !c.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true, writable: true });
  g.KeeprPair = P;
  const state: { current: Pairing } = { current: null };
  if (paired) {
    const key = await webcrypto.subtle.importKey("raw", Buffer.from(TEST_KEY_HEX, "hex"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    state.current = { pairId: TEST_PAIR_ID, key: key as unknown as CryptoKey };
  }
  g.KeeprPairKeyStore = {
    get: async () => state.current,
    put: async (v: Pairing) => {
      state.current = v;
    },
    clear: async () => {
      state.current = null;
    },
  };
  return state;
}

export function uninstallPairing(): void {
  const g = globalThis as Record<string, unknown>;
  delete g.KeeprPair;
  delete g.KeeprPairKeyStore;
}

/** A fetch Response-like reply, signed as Keepr signs it (when the request was signed). */
export function signedReply(url: string, init: { headers?: Record<string, string> }, status: number, body: unknown, keyHex = TEST_KEY_HEX) {
  const text = JSON.stringify(body);
  const nonce = init.headers?.["X-Keepr-Nonce"];
  const path = new URL(url).pathname;
  const sig = nonce ? P.sign(keyHex, P.replyString(status, path, nonce, text)) : null;
  return {
    status,
    text: async () => text,
    json: async () => body,
    headers: { get: (h: string) => (h.toLowerCase() === "x-keepr-sig" ? sig : null) },
  };
}
