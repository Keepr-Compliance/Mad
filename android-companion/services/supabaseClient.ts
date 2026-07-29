/**
 * Supabase Client for React Native (Keepr Companion)
 *
 * Initializes the Supabase client with AsyncStorage for session persistence.
 * Uses the same Supabase project as the desktop app.
 *
 * The anon key is a public/publishable key — safe to include in client code.
 * Row Level Security (RLS) on the Supabase side protects data access.
 */

import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SUPABASE_URL = 'https://nercleijfrxqcvfjskbc.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5lcmNsZWlqZnJ4cWN2Zmpza2JjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMyNDc5MTUsImV4cCI6MjA3ODgyMzkxNX0.3M2yiV4ITyny4hmgisJM-v1WfcDqaUUDEVav0DpzUvs';

/**
 * BACKLOG-2326: distinctive marker headers for companion requests.
 *
 * DEFENSE-IN-DEPTH ONLY. The broker's single-desktop enforcement spares the companion by never
 * tracking the phone as a desktop login, so correctness does NOT depend on this marker. It exists
 * so the broker's SQL companion backstop can positively recognize a companion session as a last
 * resort. GoTrue overwrites auth.sessions.user_agent on token refresh, so once the companion
 * refreshes, this User-Agent replaces the raw "okhttp/x.y.z" the RN client would otherwise send.
 * Note: React Native / okhttp may ignore a custom User-Agent — that is acceptable, as the backstop
 * also matches raw "okhttp" and the phone is never tracked as a desktop session regardless.
 */
export const COMPANION_CLIENT_HEADERS = {
  'User-Agent': 'KeeprCompanion (Android)',
  'X-Client-Info': 'keepr-companion',
} as const;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // Important for React Native — prevents URL detection for OAuth
    detectSessionInUrl: false,
  },
  global: {
    headers: { ...COMPANION_CLIENT_HEADERS },
  },
});
