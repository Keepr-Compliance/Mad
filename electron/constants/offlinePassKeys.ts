/**
 * Offline pass verification keys (BACKLOG-3675).
 *
 * Map of key id (`kid` in the pass header) → Ed25519 PUBLIC key, as SPKI DER
 * encoded in base64 (the output of `openssl pkey -pubout -outform DER | base64`).
 * Public keys are not secret; they ship in the app.
 *
 * k1 is the production offline pass verification key. An unknown kid, or an
 * empty map, rejects every offline pass (online unlimited is not affected).
 * `scripts/ci/check-offline-pass-keys.mjs` fails the release workflow if the
 * map is empty or holds an entry that is not an Ed25519 SPKI public key.
 *
 * Rotation: add the new kid here and release; switch the issuer's secret; a
 * later release removes the old kid. An unknown kid is always rejected.
 */
export const OFFLINE_PASS_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  k1: "MCowBQYDK2VwAyEAeTwMX9gaIV82+BWa/sadZXDIitPk2IHLgJcmgymcm3E=",
});
