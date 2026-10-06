/**
 * Is the Keepr Chrome extension live in the Chrome Web Store? The MAIN-process
 * copy (the renderer has a mirror, kept equal by a parity test). Used by
 * the main process (the Downloads copy is refreshed only while unpublished:
 * a store install updates itself).
 *
 * Flip to true once the extension is live in the Chrome Web Store — and its
 * renderer mirror (src/components/settings/android/extensionDistribution.ts);
 * extensionPublishedParity.test.ts fails if the two differ.
 */
export const EXTENSION_PUBLISHED = false;
