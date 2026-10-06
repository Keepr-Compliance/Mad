/**
 * Is the Keepr Chrome extension live in the Chrome Web Store? The ONE source
 * of truth for the renderer (the install path, the "update ready" line) and
 * the main process (the Downloads copy is refreshed only while unpublished:
 * a store install updates itself).
 *
 * Flip to true once the extension is live in the Chrome Web Store.
 */
export const EXTENSION_PUBLISHED = false;
