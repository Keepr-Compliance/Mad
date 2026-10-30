'use client';

/**
 * Official "Download from the Microsoft Store" badge — BACKLOG-4067.
 *
 * Renders nothing unless a valid Store ID is configured AND the visitor is on
 * Windows. The artwork is Microsoft's, vendored unmodified under
 * public/badges/ (a third-party script would be refused by the CSP, and a
 * hotlink would add a third-party request to authenticated pages).
 *
 * Detection runs in useEffect, so the server render is always empty and there
 * is no hydration mismatch. Pass `show` when the parent has already detected
 * the platform, so both use the same answer.
 */

import { useEffect, useState } from 'react';
import { detectPlatform } from '@/lib/download/platform';
import { microsoftStoreUrl } from '@/lib/download/microsoftStore';

export interface MicrosoftStoreBadgeProps {
  /** Override the configured Store ID (tests). */
  productId?: string;
  /** Parent's own platform decision; when omitted the badge detects Windows itself. */
  show?: boolean;
  theme?: 'dark' | 'light';
  /** Optional caption shown above the badge; hidden with it. */
  label?: string;
  className?: string;
}

export function MicrosoftStoreBadge({ productId, show, theme = 'dark', label, className }: MicrosoftStoreBadgeProps) {
  const [isWindows, setIsWindows] = useState(false);

  useEffect(() => {
    if (show === undefined) setIsWindows(detectPlatform() === 'windows');
  }, [show]);

  const visible = show ?? isWindows;
  const href = microsoftStoreUrl(productId);
  if (!visible || !href) return null;

  const badge = (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 ${className ?? ''}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static vendored SVG; next/image adds nothing here */}
      <img
        src={`/badges/microsoft-store-${theme}.svg`}
        alt="Download from the Microsoft Store"
        width={200}
        height={55}
      />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );

  if (!label) return badge;
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-500">{label}</p>
      {badge}
    </div>
  );
}
