/**
 * Device Identity (Android Companion) — BACKLOG-2987
 *
 * ===========================================================================
 * THE PHONE OWNS ITS IDENTITY. THE PAIRING DOES NOT.
 * ===========================================================================
 *
 * BACKLOG-2210 moved the minting of the device id to the DESKTOP, to end the
 * collision where two phones with the same NAME shared one identity. That half
 * is correct and unchanged. The desktop already implements the reuse half too —
 * `localSyncService.handleRegister` runs
 * `isMintedDeviceId(claimed) ? claimed : crypto.randomUUID()`, so a phone that
 * presents a UUID-shaped claim keeps the id it already has.
 *
 * It was never presented one. Both QR-scan handlers sent the QR's
 * `deviceName` as the claim:
 *
 *     registerDevice({ ip, port, secret, deviceId: data.deviceName })
 *
 * A name is never UUID-shaped, so the desktop minted a fresh id on EVERY
 * re-pair, forever. The adopted UUID was written into the stored pairing and
 * then never sent back.
 *
 * WHAT THAT COST, measured on the founder's machine 2026-08-29: four syncs from
 * one physical phone under four different device UUIDs. Android contact
 * stale-deletion is scoped per device id, so three of the four runs deleted
 * NOTHING (`deleted=0`) and each left another 389-row snapshot behind under a
 * phantom device. He saw it as *"every time i click sync it just adds another
 * copy of the same contacts."*
 *
 * THE MECHANISM IS PER RE-PAIR, NOT PER SYNC. `registerDevice` has exactly two
 * callers, both inside a QR-scan handler; `backgroundSync.runSyncCycle` never
 * registers, it reads the stored pairing. The founder re-paired before each of
 * the four logged syncs because Force Re-import calls `stopServer()`, which
 * drops the pairing and forces a re-scan — so the log reads as "a new id every
 * sync" while the trigger is the re-pair.
 *
 * This module is the fix recorded in-repo at `localSyncService.ts` (BACKLOG-2407):
 * *"Move device identity to the companion: persist it in the phone's own storage
 * and re-present it on every pairing, so the desktop reuses rather than mints."*
 *
 * ---------------------------------------------------------------------------
 * WHY A DEDICATED KEY AND NOT `StoredPairing.deviceId`
 * ---------------------------------------------------------------------------
 * The adopted UUID already lives in `StoredPairing`, and reading it from there
 * would look like the smaller change. It is not sufficient: `unpairDevice`
 * removes `@keepr/pairing` wholesale on sign-out and on account switch
 * (BACKLOG-2203), so the identity would be destroyed and the duplication would
 * return through that path — the same bug by a different door.
 *
 * `@keepr/device-id` is therefore deliberately NOT cleared by `unpairDevice` /
 * `resetAllSyncData`. That is safe, and the reasoning is worth stating because
 * it looks like leftover state:
 *   - the id is the PHONE's identity, not this pairing's, which is the whole
 *     point of moving it here;
 *   - it is meaningless without a desktop that already knows it, and confers
 *     nothing on its own;
 *   - the desktop re-verifies the ACCOUNT cryptographically on every
 *     `/register` (BACKLOG-2224, fail-closed), so a surviving id cannot carry a
 *     phone into an account it is not signed into.
 *
 * KNOWN LIMIT, unchanged by this module and recorded at the 2407 note: Android
 * wipes app storage on uninstall, so a reinstall still presents no claim and is
 * minted a new id. That is correct behaviour for a genuinely fresh install; it
 * is only a limit in the sense that reinstalling costs one re-key.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { registerDevice } from './syncService';
import { forceFullContactResync } from './contactSyncState';
import { resetMessageCursor } from './smsQueueService';
import type { SyncResult } from '../types/sync';

/**
 * Where the phone's own device identity lives.
 *
 * Separate from `@keepr/pairing` on purpose — see the module header. Nothing in
 * `smsQueueService.resetAllSyncData()` or `pairingManager.unpairDevice()`
 * touches this key, and that is asserted by a test rather than left to a reader
 * to notice.
 */
export const DEVICE_ID_STORAGE_KEY = '@keepr/device-id';

/**
 * The shape of a desktop-minted device id, transcribed from the desktop's
 * `isMintedDeviceId` in `electron/services/localSyncService.ts`.
 *
 * TWO COPIES OF ONE REGEX, AND WHY THAT IS ACCEPTED HERE: the desktop and the
 * companion are separate builds with no shared module (the companion is a
 * distinct Expo app with its own dependency tree), so a single spelling is not
 * available without publishing a package. The duplication is bounded by the
 * fact that only the DESKTOP's copy decides anything — it is the one that mints
 * or reuses. This copy is a guard so the companion never persists a value the
 * desktop would refuse to honour, e.g. a legacy `deviceId = deviceName` echoed
 * back by an older desktop that does not mint at all. If they ever disagree the
 * failure is conservative: we decline to store, and the next register mints,
 * which is exactly today's behaviour.
 */
const MINTED_DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` is shaped like a desktop-minted per-pairing UUID. */
export function isMintedDeviceId(id: string | null | undefined): boolean {
  return typeof id === 'string' && MINTED_DEVICE_ID.test(id);
}

/**
 * The device id this phone has already been given, or `null` if it has none.
 *
 * Never throws: an unreadable AsyncStorage yields `null`, which routes to a
 * fresh mint — degraded, but identical to today's behaviour, and a pairing that
 * fails because storage hiccuped would be worse.
 */
export async function getStoredDeviceIdentity(): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY);
    return isMintedDeviceId(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Persist a desktop-minted device id as this phone's identity.
 *
 * Refuses anything that is not UUID-shaped, so an old desktop echoing our own
 * name-derived claim back at us can never be mistaken for an identity. Returns
 * whether it stored.
 */
export async function adoptDeviceIdentity(id: string | null | undefined): Promise<boolean> {
  if (!isMintedDeviceId(id)) return false;
  try {
    await AsyncStorage.setItem(DEVICE_ID_STORAGE_KEY, id as string);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `deviceId` to present at `/register`: the identity we already hold, or
 * `fallbackDeviceId` (the QR `deviceName`) when we hold none.
 *
 * The fallback is not a compromise — on a genuinely first pair there is nothing
 * to re-present and minting is the correct outcome. It is the SECOND and every
 * later pair that must carry the id forward.
 */
export async function deviceIdClaimFor(fallbackDeviceId: string): Promise<string> {
  return (await getStoredDeviceIdentity()) ?? fallbackDeviceId;
}

/** Connection half of a scanned QR — everything except the identity. */
export interface RegisterConnection {
  ip: string;
  port: number;
  secret: string;
}

/** What `registerWithStoredIdentity` reports back to a pairing screen. */
export type RegisterWithIdentityResult = Awaited<ReturnType<typeof registerDevice>> & {
  /** The id we PRESENTED. Useful for diagnosis; not the identity to store. */
  claimedDeviceId: string;
  /** Whether the desktop's answer was persisted as this phone's identity. */
  adopted: boolean;
};

/**
 * Register with the desktop presenting the identity this phone already holds,
 * and adopt whatever the desktop answers with.
 *
 * ONE SPELLING, TWO CALLERS. `app/(main)/home.tsx` and
 * `app/onboarding/pair-device.tsx` both pair, and before this module both
 * carried their own transcription of the register-then-adopt sequence — which
 * is how they both came to send `data.deviceName`. The whole round trip lives
 * here so a future third pairing surface cannot reintroduce the defect by
 * copying the wrong half.
 *
 * `forceFullContactResync()` still runs on every successful register that
 * carries a `deviceId`, exactly as both screens did before. It is REQUIRED when
 * the id changed (the desktop must re-key and stale-delete the old rows) and it
 * is deliberately kept when the id was REUSED: a full snapshot is what makes
 * the desktop's stale-delete fire, which is the mechanism that removes the
 * duplicate snapshots this item is about. The cost is one full address-book
 * send per pairing, which is what shipped before.
 *
 * `resetMessageCursor()` is the MESSAGE half of the same idea, and it was
 * missing until BACKLOG-2995. The SMS high-water mark is phone-owned and the
 * desktop never asks for "everything after T", so a desktop whose database was
 * wiped silently received only messages newer than whatever this phone had
 * already sent — while sync reported success. Both resets now run on the same
 * successful-register path, so a pairing surface cannot pick up one and miss
 * the other.
 *
 * Both are AFTER the success check on purpose: a failed pairing attempt must
 * not cost the phone its place in its own history.
 *
 * Never throws — `registerDevice` maps every network/timeout/HTTP failure to a
 * result, and the storage writes here swallow their own errors.
 */
export async function registerWithStoredIdentity(
  connection: RegisterConnection,
  fallbackDeviceId: string,
): Promise<RegisterWithIdentityResult> {
  const claimedDeviceId = await deviceIdClaimFor(fallbackDeviceId);

  const result: SyncResult & {
    deviceId?: string;
    capabilities?: { contactDiff?: boolean };
    status?: number;
  } = await registerDevice({ ...connection, deviceId: claimedDeviceId });

  if (!result.success || !result.deviceId) {
    return { ...result, claimedDeviceId, adopted: false };
  }

  const adopted = await adoptDeviceIdentity(result.deviceId);
  await forceFullContactResync();

  // Guarded because this function promises never to throw, and the caller is a
  // pairing screen. If clearing the cursor fails, the phone keeps its old
  // high-water mark — it re-sends less than it should, which is the bug this
  // item fixes — but the PAIRING still completes. Failing to pair would be the
  // worse outcome, so the error is logged rather than propagated. It is logged
  // loudly on purpose: a silently un-cleared cursor is exactly the shape of
  // BACKLOG-1448/2206, where a swallowed failure read as an empty result.
  try {
    await resetMessageCursor();
  } catch (err) {
    console.error(
      '[DeviceIdentity] BACKLOG-2995: failed to clear the SMS cursor on pair — ' +
        'this desktop may not receive message history older than the last sync:',
      err,
    );
  }

  return { ...result, claimedDeviceId, adopted };
}

export default {
  DEVICE_ID_STORAGE_KEY,
  isMintedDeviceId,
  getStoredDeviceIdentity,
  adoptDeviceIdentity,
  deviceIdClaimFor,
  registerWithStoredIdentity,
};
