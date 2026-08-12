/**
 * ContactTombstonePill (BACKLOG-2568)
 *
 * Says why a person is still on a deal after being removed from something.
 *
 * ## Why there are TWO variants and not one pill
 *
 * Removing a contact does not erase them from a transaction they were party to
 * — an audit record must not change retroactively, and a PDF already exported
 * names that person. That is the tombstone design (BACKLOG-2270/2365/2366)
 * working correctly. Nothing on screen said so, so the Clients & Contacts
 * screen and the transaction appeared to contradict each other, and the only
 * way to know they did not was to have designed it.
 *
 * There are TWO removals, on different columns of different tables, and they
 * are independent — `contactDbService.removeContact` writes only
 * `contacts.removed_at` and never touches `transaction_contacts`:
 *
 *  - `contact-removed` → deleted from the ADDRESS BOOK. The person is gone from
 *    Clients & Contacts (and from the Edit Contacts picker, so they cannot be
 *    added again) but their role on this deal survives.
 *  - `deal-removed`    → taken off THIS DEAL. The junction row is tombstoned;
 *    the person is still in the address book.
 *
 * FOUNDER DECISION (2026-08-06): two distinct labels. One pill covering both was
 * explicitly rejected — it would tell the user the wrong thing half the time.
 *
 * ## Wording
 *
 * The pill is short because it sits beside a truncating name; the tooltip
 * carries the meaning. "Deleted" alone reads like data loss, so the sentence
 * says the opposite: the record is intact and the person is restorable.
 *
 * ## Reuse, not invention
 *
 * Styling is `ImportStatusPill`'s muted branch verbatim (`SourcePill.tsx`) —
 * the app's established "this is a state, not a category" pill and its only
 * grey one. The (i) is the shared `InfoTooltip`, already used ~10x in
 * ExportModal. InfoTooltip calls `e.stopPropagation()`, which matters here:
 * both render sites sit inside cards that are themselves click targets, and
 * clicking the (i) must not open the contact preview.
 */
import React from "react";
import { InfoTooltip } from "../common/InfoTooltip";

export type ContactTombstoneVariant = "contact-removed" | "deal-removed";

const VARIANT_COPY: Record<
  ContactTombstoneVariant,
  { label: string; tooltip: string }
> = {
  "contact-removed": {
    label: "Deleted contact",
    tooltip:
      "Removed from your contacts. Kept on this deal because they were part of it — nothing was lost, and you can restore them from Clients & Contacts.",
  },
  "deal-removed": {
    label: "Removed from this deal",
    tooltip:
      "Taken off this transaction. The record is kept for the audit trail — use Restore to put them back on the deal.",
  },
};

export function ContactTombstonePill({
  variant,
  className = "",
}: {
  variant: ContactTombstoneVariant;
  className?: string;
}): React.ReactElement {
  const { label, tooltip } = VARIANT_COPY[variant];

  return (
    <span
      className={`inline-flex items-center font-medium rounded-full bg-gray-100 text-gray-500 px-2 py-0.5 text-xs ${className}`.trim()}
      data-testid={`contact-tombstone-pill-${variant}`}
    >
      {label}
      <InfoTooltip text={tooltip} />
    </span>
  );
}

export default ContactTombstonePill;
