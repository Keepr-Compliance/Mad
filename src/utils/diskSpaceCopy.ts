/**
 * Disk-space figures and refusal sentences shown to the user (BACKLOG-2743,
 * BACKLOG-2882). Pure: no React, no IPC, so components and services share one
 * spelling of each number.
 */

/**
 * Plain size formatting — real numbers, no adjectives.
 *
 * Transcribed from `MacOSMessagesImportSettings`'s `formatGb` rather than
 * re-derived, so the dialog and the panel behind it round identically. Three
 * suites assert the panel's exact strings ("61.3 GB", "2.6 GB"), and a dialog
 * that rounded differently would put two spellings of one number on screen.
 */
export function formatGb(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb < 0.1) return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  return `${gb.toFixed(1)} GB`;
}

/** `formatGb`'s units and precision, rounded in a chosen direction. */
export function formatGbDirected(bytes: number, round: (x: number) => number): string {
  if (bytes / 1e9 < 0.1) return `${round(bytes / 1e6)} MB`;
  return `${(round(bytes / 1e8) / 10).toFixed(1)} GB`;
}

/**
 * `formatGb` rounded UP: 0.1 GB, or whole MB below 0.1 GB. For figures that are
 * ADDED to reach a requirement (BACKLOG-2882), where rounding down would let
 * the printed parts sum to no more than the printed free space. Integer byte
 * counts that are exact multiples of 0.1 GB (e.g. 80e9) print unchanged.
 */
export function formatGbUp(bytes: number): string {
  return formatGbDirected(bytes, Math.ceil);
}

/** The numbers an attachment-space refusal states — all from the main process. */
export interface AttachmentSpaceRefusalFacts {
  /** Attachment bytes the copy would write (an upper bound). */
  attachmentBytes: number;
  /** Free space kept on top of the attachments. */
  headroomBytes: number;
  /** attachments + headroom: the figure the guard compared. */
  requiredBytes: number;
  /** Free space available to the app. */
  availableBytes: number;
}

/**
 * BACKLOG-2882: the refusal sentence, shared by the inline notice and this
 * dialog so they cannot drift apart.
 *
 * It states the REQUIREMENT the guard applied. It used to show only the
 * attachment estimate and the free space — the two numbers that cannot produce
 * the verdict ("needs up to 39 MB but only 1.3 GB is available. It will not
 * start.") — and hide the headroom that did.
 *
 * The sentence names the two parts the guard added (attachments, headroom) and
 * the free space, with no separate total: a total that did not equal the
 * printed parts read as an arithmetic error. The parts round UP and the free
 * space rounds DOWN, so on every refusal the printed parts add up to more than
 * the printed free space: ceil(a) + ceil(h) >= a + h = required > available >=
 * floor(available). Nearest rounding cannot promise that (a 2 GiB headroom and
 * a half-GB estimate both rounded down and printed 0.5 + 2.1 = 2.6 against
 * "only 2.6 GB is available"). The cost is that the 2 GiB headroom prints as
 * 2.2 GB.
 */
export function describeAttachmentSpaceRefusal(facts: AttachmentSpaceRefusalFacts): string {
  const available = formatGbDirected(facts.availableBytes, Math.floor);
  return (
    `Keepr needs ${formatGbUp(facts.attachmentBytes)} for the attachments plus ` +
    `${formatGbUp(facts.headroomBytes)} kept free so your Mac keeps working. ` +
    `Only ${available} is available, so the import will not start.`
  );
}
