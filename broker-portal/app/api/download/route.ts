/**
 * Download API Route
 *
 * Server-side redirect to the latest release asset.
 * Detects platform from query param or User-Agent, fetches
 * the latest version from GitHub, and 302 redirects to the file.
 *
 * Usage: /api/download?platform=mac-arm
 */

import { NextRequest, NextResponse } from 'next/server';

const REPO = 'Keepr-Compliance/keepr-releases';
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`;

const FILE_PATTERNS: Record<string, string> = {
  'mac-arm': 'Keepr-VERSION-arm64.dmg',
  'mac-intel': 'Keepr-VERSION.dmg',
  'windows': 'Keepr-Setup-VERSION.exe',
};

function detectPlatformFromUA(ua: string): string {
  if (ua.includes('Mac')) return 'mac-arm';
  if (ua.includes('Win')) return 'windows';
  return 'unknown';
}

// Cache the version for 5 minutes to avoid hammering the GitHub API
let cachedVersion: string | null = null;
let cacheExpiry = 0;

async function getLatestVersion(): Promise<string | null> {
  if (cachedVersion && Date.now() < cacheExpiry) {
    return cachedVersion;
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { next: { revalidate: 300 } }
    );
    const data = await res.json();
    if (data.tag_name) {
      cachedVersion = data.tag_name.replace(/^v/, '');
      cacheExpiry = Date.now() + 5 * 60 * 1000;
      return cachedVersion;
    }
  } catch {
    // Fall through
  }
  return null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const platform = searchParams.get('platform')
    || detectPlatformFromUA(request.headers.get('user-agent') || '');

  const version = await getLatestVersion();

  if (!version || !FILE_PATTERNS[platform]) {
    return NextResponse.redirect(RELEASE_PAGE);
  }

  const file = FILE_PATTERNS[platform].replace('VERSION', version);
  const url = `https://github.com/${REPO}/releases/download/v${version}/${file}`;

  return NextResponse.redirect(url);
}
