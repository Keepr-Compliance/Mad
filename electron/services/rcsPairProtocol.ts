/**
 * BACKLOG-3666 (SR S2): the pairing protocol in Keepr's main process.
 *
 * The SAME source files the extension runs (chrome-extension/pair-protocol.js
 * + vendor/noble-p256.js) are bundled into the main-process build at BUILD
 * time (`npm run build:pair`, part of `build:electron`) as
 * dist-electron/pair-protocol.cjs — inside the app's asar, covered by its
 * integrity and code signing. Keepr NEVER loads code from the extension
 * folder (resources/chrome-extension, or the Downloads copy): those are for
 * Chrome only.
 */
import * as path from "path";
import type { PairProtocol } from "./rcsPairingAuth";

/** dist-electron/pair-protocol.cjs, next to this compiled file's folder. */
export const PAIR_PROTOCOL_BUNDLE = path.join(__dirname, "..", "pair-protocol.cjs");

export function loadPairProtocol(): PairProtocol {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the build-time bundle (see above)
  return require(PAIR_PROTOCOL_BUNDLE) as PairProtocol;
}
