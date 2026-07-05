/**
 * Supabase Client - Browser/Client Component
 *
 * Use this in client components (with "use client" directive)
 *
 * BACKLOG-1632: Clears corrupted Supabase session data from both
 * localStorage and cookies on module load, before the SDK initializes.
 * This prevents "Invalid UTF-8 sequence" crashes in the SDK's internal
 * base64url decoder.
 */

import { createBrowserClient } from '@supabase/ssr';
import * as Sentry from '@sentry/nextjs';

/**
 * Clear corrupted Supabase auth data from localStorage.
 */
function clearCorruptedSession(): void {
  if (typeof window === 'undefined') return;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.includes('supabase') || key.includes('sb-'))) {
        try {
          const value = localStorage.getItem(key);
          if (value) JSON.parse(value);
        } catch {
          console.warn(`[Supabase] Removed corrupted localStorage key: ${key}`);
          localStorage.removeItem(key);
        }
      }
    }
  } catch {
    // localStorage unavailable
  }
}

/**
 * Clear corrupted Supabase auth cookies.
 * If a token (after chunk reassembly) is corrupted, expire ALL its chunks.
 * Uses the SDK's own decode path to test validity.
 *
 * IMPORTANT: chunked cookies (name.0, name.1, ...) are slices of ONE encoded
 * value and MUST be reassembled in order before decoding. Validating a chunk
 * on its own always fails (a slice can't align with base64), which used to
 * make this helper destroy every healthy multi-chunk session on page load.
 */
function clearCorruptedCookies(): void {
  if (typeof document === 'undefined') return;
  try {
    const cookies = document.cookie.split(';').map(c => c.trim());
    const corruptedPrefixes = new Set<string>();

    // Group supabase cookies by base name, collecting chunks in suffix order
    const groups = new Map<string, Map<number, string>>();
    for (const cookie of cookies) {
      const eqIndex = cookie.indexOf('=');
      if (eqIndex === -1) continue;
      const name = cookie.substring(0, eqIndex);
      const value = cookie.substring(eqIndex + 1);
      if (!name.includes('supabase') && !name.startsWith('sb-')) continue;

      const chunkMatch = name.match(/^(.*)\.(\d+)$/);
      const base = chunkMatch ? chunkMatch[1] : name;
      const index = chunkMatch ? parseInt(chunkMatch[2], 10) : 0;
      if (!groups.has(base)) groups.set(base, new Map());
      groups.get(base)!.set(index, value);
    }

    // Validate each token as a whole (chunks reassembled in order)
    for (const [base, chunks] of groups) {
      try {
        const combined = Array.from(chunks.keys())
          .sort((a, b) => a - b)
          .map((i) => decodeURIComponent(chunks.get(i)!))
          .join('');
        if (!combined.startsWith('base64-')) continue;

        // Replicate the SDK's full decode path: base64url -> bytes -> UTF-8
        const base64 = combined.substring(7).replace(/-/g, '+').replace(/_/g, '/');
        // base64url omits padding; restore it before atob
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        corruptedPrefixes.add(base);
      }
    }

    // Second pass: expire ALL chunks of corrupted tokens
    if (corruptedPrefixes.size > 0) {
      const clearedNames: string[] = [];
      for (const cookie of cookies) {
        const name = cookie.split('=')[0];
        const prefix = name.replace(/\.\d+$/, '');
        if (corruptedPrefixes.has(prefix) || corruptedPrefixes.has(name)) {
          console.warn(`[Supabase] Clearing corrupted cookie: ${name}`);
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
          clearedNames.push(name);
        }
      }
      // Try to identify the affected user from localStorage before reporting
      let affectedUser: string | null = null;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.includes('sb-') && key.includes('auth-token')) {
            const raw = localStorage.getItem(key);
            if (raw) {
              const parsed = JSON.parse(raw);
              affectedUser = parsed?.user?.email || parsed?.user?.id || null;
              if (affectedUser) break;
            }
          }
        }
      } catch {
        // Can't read user info — report without it
      }

      // Report to Sentry so we can track frequency in production
      Sentry.captureMessage('Corrupted Supabase auth cookies detected and cleared', {
        level: 'warning',
        tags: { component: 'supabase-client', operation: 'cookie-cleanup' },
        extra: { clearedCookies: clearedNames, prefixes: [...corruptedPrefixes], affectedUser },
      });
    }
  } catch {
    // document.cookie unavailable
  }
}

// Run once on module load
clearCorruptedSession();
clearCorruptedCookies();

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
