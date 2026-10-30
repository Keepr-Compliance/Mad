/**
 * Microsoft Store listing link — BACKLOG-4067.
 *
 * The badge is switched on by setting NEXT_PUBLIC_MS_STORE_PRODUCT_ID in
 * Vercel (production and preview) and redeploying: NEXT_PUBLIC_ values are
 * inlined at build time. While it is empty or invalid, no badge renders.
 *
 * SILENT FAILURE: a misnamed variable, or one set on preview only, looks
 * exactly like "off" — nothing errors. Check the preview with a Windows UA
 * after setting it. In non-production builds a set-but-invalid value logs a
 * warning (e.g. the Partner Center product GUID pasted instead of the Store ID).
 *
 * Store ID shapes: MSIX/UWP apps have 12 characters starting with 9
 * (9NBLGGH4NNS1); EXE/MSI apps have 14 characters starting with XP
 * (XP89DCGQ3K6VLD). The anchors reject a truncated XP id.
 */

const STORE_ID_PATTERN = /^(9[0-9A-Z]{11}|XP[0-9A-Z]{12})$/;

/**
 * `full` opens the Store app's product page. `direct` would download
 * Microsoft's Store installer from the browser — a second .exe next to the
 * primary installer button.
 */
export const MS_STORE_LINK_MODE = 'full';

/** The configured Store ID. Read at call time so tests can vary it; Next still inlines the literal. */
export function configuredStoreProductId(): string {
  return process.env.NEXT_PUBLIC_MS_STORE_PRODUCT_ID ?? '';
}

export function isValidStoreProductId(id: string | undefined | null): id is string {
  return typeof id === 'string' && STORE_ID_PATTERN.test(id);
}

/** The listing URL, or null when the id is empty or not a Store ID. */
export function microsoftStoreUrl(id: string | undefined | null = configuredStoreProductId()): string | null {
  const trimmed = (id ?? '').trim();
  if (!isValidStoreProductId(trimmed)) {
    if (trimmed !== '' && process.env.NODE_ENV !== 'production') {
      console.warn(
        `[microsoftStore] NEXT_PUBLIC_MS_STORE_PRODUCT_ID is set but is not a Microsoft Store ID ` +
          `(expected 9 + 11 or XP + 12 characters); the Store badge stays hidden.`,
      );
    }
    return null;
  }
  return `https://apps.microsoft.com/detail/${trimmed}?mode=${MS_STORE_LINK_MODE}`;
}
