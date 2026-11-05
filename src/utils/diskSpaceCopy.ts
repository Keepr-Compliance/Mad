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
 * Required is rounded UP and available DOWN. Rounding both to nearest let them
 * print identically near the boundary (2.6455 GB vs 2.6454 GB, both "2.6 GB"
 * — or "2.65 GB" at two decimals), which shows no shortfall at all. With
 * directional rounding, required > available implies ceil(required) >
 * floor(available), so the pair can never be disproved, and each figure stays
 * true as an upper / lower bound.
 */
export function describeAttachmentSpaceRefusal(facts: AttachmentSpaceRefusalFacts): string {
  const required = formatGbDirected(facts.requiredBytes, Math.ceil);
  const available = formatGbDirected(facts.availableBytes, Math.floor);
  return (
    `This import needs up to ${required} of free space — up to ` +
    `${formatGb(facts.attachmentBytes)} for attachments, plus ` +
    `${formatGb(facts.headroomBytes)} kept free so your Mac can keep working — ` +
    `but only ${available} is available. It will not start.`
  );
}

