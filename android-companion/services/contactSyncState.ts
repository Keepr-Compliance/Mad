/**
 * Contact Sync State (Android Companion)
 *
 * BACKLOG-2208: Diff contacts instead of full re-send.
 *
 * Before this, every sync cycle re-sent the ENTIRE address book to the desktop
 * (contactReader read all contacts, backgroundSync sent them all). The desktop
 * upserts under `android-{deviceId}-{contact.id}`, so no duplicate rows were
 * created, but every cycle burned bandwidth/CPU and logged `inserted=N` even
 * when nothing changed — muddying "what actually changed".
 *
 * This module tracks a per-contact content FINGERPRINT (sha256 over the stable
 * fields the desktop stores) persisted in AsyncStorage, so each cycle can send
 * only the contacts that are NEW or CHANGED since the last successful sync.
 *
 * FULL vs PARTIAL (desktop-compat — the decisive constraint):
 * The desktop's `/sync/contacts` handler treats each POST as a FULL SNAPSHOT:
 * it upserts the batch and then DELETES any `android_sync` contact NOT in the
 * batch (externalContactDbService.deleteStaleContactsBySource). So a partial
 * (diff) batch MUST be tagged `isFullSync:false` on the wire so the desktop
 * upserts only and skips the stale-deletion — otherwise it would delete every
 * unchanged contact. See computeContactDiff().isFullSync + syncService.sendContacts.
 *
 * Deletions: phone-side contact deletions are reconciled ONLY on a FULL sync
 * (first run, after re-pair/reset, and the periodic re-sync below), never on a
 * continuous diff cycle. This preserves the pre-2208 deletion behavior (which
 * only ever happened on a full snapshot) without regressing it.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import forge from "node-forge";
import type { SyncContact } from "../types/contacts";

// ============================================
// CONSTANTS
// ============================================

/** contactId -> content fingerprint (hex sha256) of the last synced state. */
const CONTACT_FINGERPRINTS_KEY = "@keepr/contact-fingerprints";

/** Unix ms of the last FULL contact sync (drives the periodic re-sync). */
const CONTACT_LAST_FULL_SYNC_KEY = "@keepr/contact-last-full-sync";

/**
 * Whether the currently-paired desktop advertised support for incremental
 * contact diffs (BACKLOG-2208 register-time capability handshake). Only "true"
 * when a desktop /register response included `capabilities.contactDiff: true`.
 *
 * This is the safety interlock that keeps a NEW companion from sending partial
 * diffs to an OLD desktop (which ignores `isFullSync` and would stale-delete
 * every contact omitted from the diff): until a desktop actively advertises the
 * capability, the companion always sends the FULL address book.
 */
const CONTACT_DIFF_SUPPORTED_KEY = "@keepr/contact-diff-supported";

/**
 * How often to force a FULL contact re-sync even when nothing changed.
 *
 * A full sync is the ONLY thing that (a) lets the desktop reconcile phone-side
 * deletions (its stale-deletion runs only on a full snapshot) and (b) self-heals
 * any divergence — including the transient rollout case where a NEW phone (which
 * sends diffs) is talking to an OLD desktop that ignores `isFullSync` and always
 * stale-deletes. 24h keeps the steady-state cost negligible (one full re-send a
 * day) while bounding how long a deletion/divergence can persist.
 */
export const FULL_RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ============================================
// TYPES
// ============================================

/** contactId -> fingerprint map. */
type FingerprintMap = Record<string, string>;

/** Outcome of diffing the current address book against the stored fingerprints. */
export interface ContactDiff {
  /**
   * The contacts to actually transmit this cycle: ALL current contacts on a full
   * sync, only the new/changed ones on a partial sync.
   */
  toSend: SyncContact[];
  /**
   * Whether this cycle is a FULL sync (first run / after reset / periodic
   * re-sync). Sent on the wire so the desktop knows whether to stale-delete.
   */
  isFullSync: boolean;
  /**
   * Count of genuinely NEW or CHANGED contacts vs the stored fingerprints,
   * independent of full/partial. Drives the "New Contacts" UI stat, so a
   * periodic full re-send with nothing actually changed reports 0.
   */
  newOrChanged: number;
}

// ============================================
// FINGERPRINTING
// ============================================

/**
 * Build a stable, order-independent canonical string for a contact over exactly
 * the fields the desktop stores. Phone-number and email SETS are sorted so a
 * provider reordering the same values does not look like a change; email is
 * lower-cased; labels are intentionally ignored (the desktop keys on the value,
 * not the label, so a "mobile"->"work" relabel should not force a re-send).
 */
function canonicalContact(contact: SyncContact): string {
  const phones = (contact.phones ?? [])
    .map((p) => (p.number ?? "").trim())
    .filter((n) => n.length > 0)
    .sort();

  const emails = (contact.emails ?? [])
    .map((e) => (e.address ?? "").trim().toLowerCase())
    .filter((a) => a.length > 0)
    .sort();

  return JSON.stringify({
    id: contact.id,
    name: (contact.displayName ?? "").trim(),
    phones,
    emails,
    company: (contact.company ?? "").trim(),
    title: (contact.title ?? "").trim(),
  });
}

/**
 * Content fingerprint (hex sha256) of a contact's stable fields. Uses node-forge
 * (pure JS, synchronous) — the same crypto dependency the encryption layer uses,
 * so this works identically under Hermes and in jest/node.
 */
export function fingerprintContact(contact: SyncContact): string {
  const md = forge.md.sha256.create();
  md.update(canonicalContact(contact));
  return md.digest().toHex();
}

// ============================================
// STORAGE
// ============================================

async function getFingerprints(): Promise<FingerprintMap> {
  try {
    const stored = await AsyncStorage.getItem(CONTACT_FINGERPRINTS_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as FingerprintMap;
  } catch {
    return {};
  }
}

async function setFingerprints(map: FingerprintMap): Promise<void> {
  await AsyncStorage.setItem(CONTACT_FINGERPRINTS_KEY, JSON.stringify(map));
}

async function getLastFullSyncAt(): Promise<number | null> {
  try {
    const stored = await AsyncStorage.getItem(CONTACT_LAST_FULL_SYNC_KEY);
    if (!stored) return null;
    const ts = parseInt(stored, 10);
    return isNaN(ts) ? null : ts;
  } catch {
    return null;
  }
}

async function setLastFullSyncAt(timestamp: number): Promise<void> {
  await AsyncStorage.setItem(CONTACT_LAST_FULL_SYNC_KEY, String(timestamp));
}

/**
 * Record whether the paired desktop supports incremental contact diffs, read
 * from its /register response `capabilities.contactDiff` (BACKLOG-2208).
 * Persisted so every subsequent background/manual sync can honor it without
 * re-registering.
 */
export async function setContactDiffSupported(supported: boolean): Promise<void> {
  await AsyncStorage.setItem(
    CONTACT_DIFF_SUPPORTED_KEY,
    supported ? "true" : "false"
  );
}

/**
 * Whether the paired desktop supports incremental contact diffs.
 *
 * FAIL-SAFE default is `false`: an old desktop never advertises the capability,
 * and an unknown/unreadable value must also mean "send full" — the companion
 * only opts into diffs when a desktop has explicitly confirmed support.
 */
export async function isContactDiffSupported(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(CONTACT_DIFF_SUPPORTED_KEY);
    return stored === "true";
  } catch {
    return false;
  }
}

// ============================================
// DIFF + COMMIT
// ============================================

/**
 * Compute which contacts to send this cycle.
 *
 * @param current - contacts read from the device THIS cycle (already id-guarded
 *   by contactReader). Callers pass exactly what they intend to reconcile.
 * @param now - injectable clock for tests (defaults to Date.now()).
 * @param forceFull - when true, always return a FULL sync (all contacts, no
 *   diff). backgroundSync passes this when the paired desktop has NOT advertised
 *   `contactDiff` support, so a new companion never sends a partial batch to an
 *   old desktop. `newOrChanged` is still the genuine new/changed count so the
 *   "New Contacts" UI stat stays meaningful even on a forced-full cycle.
 */
export async function computeContactDiff(
  current: SyncContact[],
  now: number = Date.now(),
  forceFull = false
): Promise<ContactDiff> {
  const [map, lastFull] = await Promise.all([
    getFingerprints(),
    getLastFullSyncAt(),
  ]);

  // Genuinely new (no stored fingerprint) or changed (fingerprint differs).
  const changed = current.filter(
    (c) => map[c.id] !== fingerprintContact(c)
  );

  // Force a full sync when the caller demands it (desktop lacks diff support),
  // when we have never synced (empty map / no full-sync stamp), or when the
  // periodic interval has elapsed. A full sync is what lets the desktop
  // reconcile deletions and heals any divergence.
  const mapIsEmpty = Object.keys(map).length === 0;
  const periodicDue =
    lastFull === null || now - lastFull >= FULL_RESYNC_INTERVAL_MS;
  const isFullSync = forceFull || mapIsEmpty || periodicDue;

  return {
    toSend: isFullSync ? current : changed,
    isFullSync,
    newOrChanged: changed.length,
  };
}

/**
 * Persist the post-send fingerprint state. Call ONLY after the desktop accepted
 * the batch, so a failed send is naturally retried next cycle.
 *
 * @param current - the full set of contacts read this cycle (used to rebuild the
 *   map on a full sync).
 * @param sent - the contacts actually transmitted this cycle.
 * @param isFullSync - whether this was a full sync.
 * @param now - injectable clock for tests.
 */
export async function commitContactSync(
  current: SyncContact[],
  sent: SyncContact[],
  isFullSync: boolean,
  now: number = Date.now()
): Promise<void> {
  if (isFullSync) {
    // Rebuild the map from the full current set so stale entries (contacts no
    // longer on the device) drop out, and stamp the full-sync time.
    const rebuilt: FingerprintMap = {};
    for (const c of current) {
      rebuilt[c.id] = fingerprintContact(c);
    }
    await Promise.all([
      setFingerprints(rebuilt),
      setLastFullSyncAt(now),
    ]);
    return;
  }

  // Partial: merge fingerprints for exactly what we sent; leave the rest intact
  // and do NOT advance the full-sync clock.
  if (sent.length === 0) return;
  const map = await getFingerprints();
  for (const c of sent) {
    map[c.id] = fingerprintContact(c);
  }
  await setFingerprints(map);
}

/**
 * Force the NEXT contact sync to be a FULL snapshot, WITHOUT touching the
 * desktop-capability flag (BACKLOG-2210).
 *
 * Used when the phone adopts a desktop-minted deviceId: the desktop keys
 * `android_sync` contacts under `android-{deviceId}-{contact.id}` and stale-
 * deletes any `android_sync` row missing from a FULL batch (scoped by source,
 * not deviceId). So the first sync after an id change MUST be full — it upserts
 * every contact under the NEW id and stale-deletes the OLD-id rows in one shot
 * (clean re-key: no duplicate rows, no lost contacts). Clearing the fingerprint
 * map makes `computeContactDiff` return `isFullSync=true` next cycle.
 *
 * Deliberately does NOT clear CONTACT_DIFF_SUPPORTED_KEY (unlike
 * resetContactSyncState): registerDevice just set it from the fresh /register
 * response, so wiping it here would make the companion re-send the full address
 * book every cycle forever (losing the BACKLOG-2208 diff optimisation).
 */
export async function forceFullContactResync(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(CONTACT_FINGERPRINTS_KEY),
    AsyncStorage.removeItem(CONTACT_LAST_FULL_SYNC_KEY),
  ]);
}

/**
 * Clear all contact-sync state so the next sync sends the FULL set once.
 * Called from smsQueueService.resetAllSyncData() on unpair (BACKLOG-2203).
 */
export async function resetContactSyncState(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(CONTACT_FINGERPRINTS_KEY),
    AsyncStorage.removeItem(CONTACT_LAST_FULL_SYNC_KEY),
    // Clear the desktop-capability flag too: a re-pair must re-read it from the
    // fresh /register response rather than trust the previous desktop's answer.
    AsyncStorage.removeItem(CONTACT_DIFF_SUPPORTED_KEY),
  ]);
}
