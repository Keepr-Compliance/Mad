'use client';

/**
 * Android Download Page
 *
 * Dedicated landing page for downloading the Keepr Companion Android app.
 * Auto-triggers the APK download after a short delay with a manual fallback.
 *
 * BACKLOG-1482: Separated from main download page for a focused mobile experience.
 *
 * @module download/android
 */

import { useEffect, useState } from 'react';
import { ArrowLeft, Download } from 'lucide-react';
import { buttonClasses } from '@keepr/design-system';

const APK_URL = 'https://github.com/5hdaniel/Mad/releases/download/v1.0.0-companion-beta/app-debug.apk';

export default function AndroidDownloadPage() {
  const [autoStarted, setAutoStarted] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setAutoStarted(true);
      window.location.href = APK_URL;
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <h1 className="text-3xl font-bold text-gray-900">Keepr.</h1>

        <div className="bg-white rounded-lg border border-gray-200 p-8 space-y-5">
          <div className="flex items-center justify-center gap-3">
            <div className="w-10 h-10 bg-success-100 rounded-full flex items-center justify-center flex-shrink-0">
              <svg
                className="w-6 h-6 text-success-600"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24a11.463 11.463 0 00-8.94 0L5.65 5.67c-.19-.29-.54-.38-.84-.22-.3.16-.42.54-.26.85L6.4 9.48A10.78 10.78 0 002 18h20a10.78 10.78 0 00-4.4-8.52zM7 15.25a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zm10 0a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-900">
              Keepr Companion for Android
            </h2>
          </div>

          {autoStarted ? (
            <p className="text-gray-600">
              Your download should begin automatically.
              If it doesn&apos;t,{' '}
              <a
                href={APK_URL}
                className="text-success-600 hover:text-success-700 underline"
              >
                click here to download
              </a>.
            </p>
          ) : (
            <p className="text-gray-600">
              Sync SMS messages from your Android phone to Keepr over your local
              WiFi network.
            </p>
          )}

          {/* Download button */}
          <a
            href={APK_URL}
            className={buttonClasses('success', 'md', 'w-full')}
          >
            <Download className="h-4 w-4" />
            <span>Download APK</span>
          </a>

          {/* Installation instructions */}
          <div className="border-t border-gray-100 pt-4 space-y-3">
            <p className="text-sm font-medium text-gray-700">
              Installation Instructions
            </p>
            <ol className="text-sm text-gray-600 space-y-2 list-decimal list-inside text-left">
              <li>
                When prompted, tap{' '}
                <span className="font-medium text-gray-900">Install</span>{' '}
                (you may need to allow installing from this source)
              </li>
              <li>Open the app and sign in with your Keepr account</li>
              <li>Follow the setup to pair with your desktop</li>
            </ol>
          </div>

          {/* Google Play coming soon */}
          <div className="border-t border-gray-100 pt-4">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-gray-50 rounded-lg">
              <svg
                className="w-5 h-5 text-gray-400"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.199l2.302 2.302a1 1 0 010 1.38l-2.302 2.302L15.396 12l2.302-3.492zM5.864 2.658L16.8 8.99l-2.302 2.302L5.864 2.658z" />
              </svg>
              <span className="text-sm text-gray-500">
                Coming soon to Google Play Store
              </span>
            </div>
          </div>
        </div>

        {/* Back link */}
        <a
          href="/download"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to all downloads
        </a>
      </div>
    </div>
  );
}
