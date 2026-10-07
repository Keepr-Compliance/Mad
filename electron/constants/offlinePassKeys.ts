/**
 * Offline pass verification keys (BACKLOG-3675).
 *
 * Map of key id (`kid` in the pass header) → Ed25519 PUBLIC key, as SPKI DER
 * encoded in base64 (the output of `openssl pkey -pubout -outform DER | base64`).
 * Public keys are not secret; they ship in the app.
 *
 * PLACEHOLDER: the map is EMPTY until the production signing key exists.
 * An empty map means every offline pass is rejected (online unlimited is not
 * affected). `scripts/ci/check-offline-pass-keys.mjs` fails the release
 * workflow while this map is empty, so a release cannot ship the placeholder.
 *
 * Rotation: add the new kid here and release; switch the issuer's secret; a
 * later release removes the old kid. An unknown kid is always rejected.
 */
export const OFFLINE_PASS_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  // k1: "<SPKI DER base64 — set after the signing key is created>",
});
