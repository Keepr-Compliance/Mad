/**
 * Deal matcher for Learn mode scoring — BACKLOG-4120.
 *
 * Decides whether a baseline-0 detection (an address key from
 * `groupByProperty`) and a local transaction are the same deal:
 *
 *   1. Street: same street number AND same `streetNameWords`
 *      (`normalizeAddress`, BACKLOG-3925 field). Not `requiredNameWords`:
 *      analyzeEmail emits keys without commas ("4120 canarytest lane testville
 *      zz 00000"), and requiredNameWords then swallows city/state/ZIP (SR
 *      review R1).
 *   2. ZIP guard: when both sides carry a ZIP and they differ, no match.
 *   3. Dates: the detection's first..last email overlaps the transaction's
 *      audit window [auditWindowStart(started_at), auditWindowEnd(closed_at)].
 *      A NULL bound is open.
 *
 * Pure: no I/O.
 */
import { normalizeAddress, type NormalizedAddress } from "../../utils/addressNormalization";
import { auditWindowEnd, auditWindowStart } from "../exportPlan";

const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/g;

/** The last 5-digit ZIP in a string, or null. */
export function zipOf(text: string | null | undefined): string | null {
  if (!text) return null;
  let last: string | null = null;
  for (const m of text.matchAll(ZIP_RE)) last = m[1];
  return last;
}

function streetWords(n: NormalizedAddress): string[] {
  return n.streetNameWords && n.streetNameWords.length > 0 ? n.streetNameWords : n.requiredNameWords;
}

/** "streetNumber nameword nameword" or null when the address has no street number. */
export function streetKey(address: string | null | undefined): string | null {
  const n = normalizeAddress(address);
  if (!n) return null;
  return `${n.streetNumber} ${streetWords(n).join(" ")}`;
}

/**
 * The key a cleanup answer is stored under: street key + ZIP ("" when none).
 * Built from the normalized address, never from a local row id.
 */
export function addressKey(address: string | null | undefined): string | null {
  const s = streetKey(address);
  if (!s) return null;
  return `${s}|${zipOf(address) ?? ""}`;
}

/** Street + ZIP guard. `txZip` is the transaction's property_zip (may be NULL). */
export function sameStreet(
  detectionAddress: string,
  txAddress: string,
  txZip: string | null | undefined,
): boolean {
  const a = streetKey(detectionAddress);
  const b = streetKey(txAddress);
  if (!a || !b || a !== b) return false;
  const zipA = zipOf(detectionAddress);
  const zipB = zipOf(txZip ?? null) ?? zipOf(txAddress);
  if (zipA && zipB && zipA !== zipB) return false;
  return true;
}

/** A transaction's window in ms; null bound = open (-Infinity / +Infinity). */
export function transactionWindowMs(
  startedAt: string | null | undefined,
  closedAt: string | null | undefined,
): { start: number; end: number } {
  const s = auditWindowStart(startedAt ?? null);
  const e = auditWindowEnd(closedAt ?? null);
  const start = s && !isNaN(s.getTime()) ? s.getTime() : -Infinity;
  const end = e && !isNaN(e.getTime()) ? e.getTime() : Infinity;
  return { start, end };
}

/** Inclusive overlap of [firstMs, lastMs] with the transaction's window. */
export function overlapsWindow(
  firstMs: number,
  lastMs: number,
  startedAt: string | null | undefined,
  closedAt: string | null | undefined,
): boolean {
  const w = transactionWindowMs(startedAt, closedAt);
  return firstMs <= w.end && lastMs >= w.start;
}

export interface MatchableTransaction {
  property_address: string;
  property_zip: string | null;
  started_at: string | null;
  closed_at: string | null;
}

export interface MatchableDetection {
  address: string;
  firstMs: number;
  lastMs: number;
}

export function isSameDeal(d: MatchableDetection, t: MatchableTransaction): boolean {
  return (
    sameStreet(d.address, t.property_address, t.property_zip) &&
    overlapsWindow(d.firstMs, d.lastMs, t.started_at, t.closed_at)
  );
}
