/**
 * The consent text shown before the first Google Messages cache Sync
 * (BACKLOG-3658 P3b). DRAFT for the founder's approval.
 *
 * Its version must equal the main process's RCS_CONSENT_VERSION
 * (electron/services/rcsCacheService.ts; a test checks it). Change the text
 * in substance → raise BOTH: every user consents again before their next Sync.
 */

export const RCS_CONSENT_COPY_VERSION = 1;

export const RCS_CONSENT_TITLE = "Before Keepr copies your texts";

/** One paragraph per item, plain language (≤120 words in all). */
export const RCS_CONSENT_PARAGRAPHS: readonly string[] = [
  "When you sync, Keepr copies ALL your Google Messages conversations from the period set in Settings → Messages to this computer, stored encrypted.",
  "That includes message text, names and phone numbers, reactions, and images from chats with your contacts.",
  "Keepr adds texts to your transactions automatically by matching phone numbers. Texts leave this computer only when you submit a transaction to your broker. Keepr never sells your data or uses it for ads.",
  "To delete what Keepr copied, use Settings → Messages → Force re-import. A per-chat \"Don't sync\" switch is coming: it will stop new messages from that chat being copied.",
];

export const RCS_CONSENT_AGREE = "I agree, sync my texts";
