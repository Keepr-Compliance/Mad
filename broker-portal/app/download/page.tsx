'use client';

/**
 * Download Page
 *
 * Public landing page for downloading the Keepr desktop app.
 * Uses server-side /api/download route for reliable redirects.
 */

import { useEffect, useState } from 'react';
import { ChevronRight, Download } from 'lucide-react';
import { buttonClasses } from '@keepr/design-system';

type Platform = 'mac-arm' | 'mac-intel' | 'windows' | 'unknown';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) {
    if (
      navigator.platform === 'MacIntel' &&
      typeof (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints === 'number' &&
      (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints! > 0
    ) {
      return 'mac-arm';
    }
    return 'mac-arm';
  }
  if (ua.includes('win')) return 'windows';
  return 'unknown';
}

const DOWNLOADS: Record<string, string> = {
  'mac-arm': 'Download for macOS (Apple Silicon)',
  'mac-intel': 'Download for macOS (Intel)',
  'windows': 'Download for Windows',
};

export default function DownloadPage() {
  const [platform, setPlatform] = useState<Platform>('unknown');
  const [autoStarted, setAutoStarted] = useState(false);

  useEffect(() => {
    const detected = detectPlatform();
    setPlatform(detected);

    // Auto-start download after a short delay
    if (detected !== 'unknown') {
      const timer = setTimeout(() => {
        setAutoStarted(true);
        window.location.href = `/api/download?platform=${detected}`;
      }, 500);
      return () => clearTimeout(timer);
    }
  }, []);

  const primaryLabel = platform !== 'unknown' ? DOWNLOADS[platform] : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <h1 className="text-3xl font-bold text-gray-900">Keepr.</h1>

        <div className="bg-white rounded-lg border border-gray-200 p-8 space-y-5">
          <h2 className="text-xl font-semibold text-gray-900">
            Download Keepr
          </h2>

          {autoStarted ? (
            <p className="text-gray-600">
              Your download should begin automatically.
              If it doesn&apos;t,{' '}
              <a
                href={`/api/download?platform=${platform}`}
                className="text-primary-600 hover:text-primary-700 underline"
              >
                click here
              </a>.
            </p>
          ) : (
            <p className="text-gray-600">
              Get the Keepr desktop app for real estate transaction auditing.
            </p>
          )}

          {/* Primary download button */}
          {primaryLabel && (
            <a
              href={`/api/download?platform=${platform}`}
              className={buttonClasses('primary', 'md', 'w-full')}
            >
              <Download className="h-4 w-4" />
              <span>{primaryLabel}</span>
            </a>
          )}

          {/* Other platforms */}
          <div className="pt-2 border-t border-gray-100 space-y-2">
            <p className="text-sm text-gray-500">Other platforms</p>
            {Object.entries(DOWNLOADS)
              .filter(([key]) => key !== platform)
              .map(([key, label]) => (
                <a
                  key={key}
                  href={`/api/download?platform=${key}`}
                  className="block text-sm text-primary-600 hover:text-primary-700"
                >
                  {label}
                </a>
              ))}
          </div>
        </div>

        {/* Android Companion App Link */}
        <a
          href="/download/android"
          className="block bg-white rounded-lg border border-gray-200 p-6 hover:border-success-300 hover:shadow-sm transition-all group"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-success-100 rounded-full flex items-center justify-center flex-shrink-0">
                <svg
                  className="w-6 h-6 text-success-600"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24a11.463 11.463 0 00-8.94 0L5.65 5.67c-.19-.29-.54-.38-.84-.22-.3.16-.42.54-.26.85L6.4 9.48A10.78 10.78 0 002 18h20a10.78 10.78 0 00-4.4-8.52zM7 15.25a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zm10 0a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z" />
                </svg>
              </div>
              <div className="text-left">
                <p className="font-semibold text-gray-900">
                  Keepr Companion for Android
                </p>
                <p className="text-sm text-gray-500">
                  Sync SMS messages over WiFi
                </p>
              </div>
            </div>
            <ChevronRight className="h-5 w-5 text-gray-400 group-hover:text-success-600 transition-colors" />
          </div>
        </a>
      </div>
    </div>
  );
}
