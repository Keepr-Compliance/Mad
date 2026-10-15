/**
 * Broker Submissions list sort - BACKLOG-3904.
 *
 * `?sort=` holds one of SORT_OPTIONS; the default (`newest`) is left out of the
 * URL. The comparators run on the deal HEADS, before the count and the page
 * slice (pageOfHeads), so a sort covers the whole list.
 *
 * "Waiting longest" measures from the head version's created_at. Every
 * resubmission is its own row, so for a new or resubmitted deal that is exactly
 * when it entered the state. An under-review deal is measured from when it was
 * submitted, not from when review started: the only per-status timestamp is
 * status_history[].changed_at, which is not in the heads read.
 */

import { compareNewestFirst, type BrokerChainLink } from './dealList';
import { formatUsAddress } from './formatUsAddress';

export type SortKey = 'newest' | 'oldest' | 'waiting' | 'status' | 'price_desc' | 'price_asc' | 'address';

export const DEFAULT_SORT: SortKey = 'newest';

export const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'waiting', label: 'Waiting longest' },
  { value: 'status', label: 'Status' },
  { value: 'price_desc', label: 'Price high to low' },
  { value: 'price_asc', label: 'Price low to high' },
  { value: 'address', label: 'Address A-Z' },
];

/** A known sort, or the default. Anything else (unknown, repeated, empty) is ignored. */
export function parseSortParam(value: string | undefined | null): SortKey {
  return SORT_OPTIONS.some((o) => o.value === value) ? (value as SortKey) : DEFAULT_SORT;
}

export function sortLabel(sort: SortKey): string {
  return SORT_OPTIONS.find((o) => o.value === sort)?.label ?? SORT_OPTIONS[0].label;
}

/** Statuses a broker still has to act on. */
const WAITING_STATUSES: readonly string[] = ['submitted', 'resubmitted', 'under_review'];

/** Pipeline order; `submitted` is the "New" status. */
const STATUS_ORDER: readonly string[] = [
  'submitted',
  'resubmitted',
  'under_review',
  'needs_changes',
  'approved',
  'rejected',
];

/** The price the row shows: sale_price, else listing_price. Null when neither. */
export function headPrice(head: BrokerChainLink): number | null {
  const raw = head.sale_price || head.listing_price;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Case-insensitive, and house numbers compare as numbers (9 before 20 before 112). */
const STREET_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function headStreet(head: BrokerChainLink): string {
  return formatUsAddress(head.property_address, head.property_city, head.property_state).street;
}

function byPrice(dir: 1 | -1) {
  return (a: BrokerChainLink, b: BrokerChainLink): number => {
    const pa = headPrice(a);
    const pb = headPrice(b);
    if (pa === null && pb === null) return compareNewestFirst(a, b);
    if (pa === null) return 1; // no price goes last in both directions
    if (pb === null) return -1;
    return pa !== pb ? (pa - pb) * dir : compareNewestFirst(a, b);
  };
}

export function compareHeads(sort: SortKey): (_a: BrokerChainLink, _b: BrokerChainLink) => number {
  switch (sort) {
    case 'oldest':
      return (a, b) => compareNewestFirst(b, a);
    case 'waiting':
      return (a, b) => {
        const wa = WAITING_STATUSES.includes(a.status ?? '');
        const wb = WAITING_STATUSES.includes(b.status ?? '');
        if (wa !== wb) return wa ? -1 : 1;
        return wa ? compareNewestFirst(b, a) : compareNewestFirst(a, b);
      };
    case 'status':
      return (a, b) => {
        const ra = STATUS_ORDER.indexOf(a.status ?? '');
        const rb = STATUS_ORDER.indexOf(b.status ?? '');
        const ia = ra === -1 ? STATUS_ORDER.length : ra;
        const ib = rb === -1 ? STATUS_ORDER.length : rb;
        return ia !== ib ? ia - ib : compareNewestFirst(a, b);
      };
    case 'price_desc':
      return byPrice(-1);
    case 'price_asc':
      return byPrice(1);
    case 'address':
      return (a, b) => {
        const c = STREET_COLLATOR.compare(headStreet(a), headStreet(b));
        return c !== 0 ? c : compareNewestFirst(a, b);
      };
    default:
      return compareNewestFirst;
  }
}
