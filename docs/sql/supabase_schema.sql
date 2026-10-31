-- ============================================
-- MAD - SUPABASE CLOUD DATABASE SCHEMA
-- ============================================
-- Purpose: Centralized user management, subscriptions, analytics
-- Deploy: Run this in Supabase SQL Editor or via supabase db push

-- ============================================
-- USERS TABLE (Cloud - Minimal)
-- ============================================
CREATE TABLE IF NOT EXISTS users (
  -- Core Identity
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT,
  avatar_url TEXT,

  -- OAuth Reference
  oauth_provider TEXT NOT NULL CHECK (oauth_provider IN ('google', 'microsoft')),
  oauth_id TEXT NOT NULL,

  -- Subscription & Billing
  subscription_tier TEXT DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro', 'enterprise')),
  subscription_status TEXT DEFAULT 'trial' CHECK (subscription_status IN ('trial', 'active', 'cancelled', 'expired')),
  trial_ends_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
  subscription_started_at TIMESTAMPTZ,

  -- Account Status
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Analytics
  login_count INTEGER DEFAULT 0,
  last_login_at TIMESTAMPTZ,
  signup_source TEXT,

  -- Legal (US/CCPA)
  terms_accepted_at TIMESTAMPTZ,
  terms_version_accepted TEXT,
  privacy_policy_accepted_at TIMESTAMPTZ,
  privacy_policy_version_accepted TEXT,
  do_not_sell_data BOOLEAN DEFAULT false,
  ccpa_opt_out_date TIMESTAMPTZ,

  UNIQUE(oauth_provider, oauth_id)
);

-- ============================================
-- LICENSES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- License Details
  license_key TEXT NOT NULL UNIQUE,
  max_devices INTEGER DEFAULT 2,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired', 'suspended')),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ
);

-- ============================================
-- DEVICES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Device Info
  device_id TEXT NOT NULL UNIQUE,
  device_name TEXT,
  os TEXT,
  app_version TEXT,

  -- Timestamps
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  activated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, device_id)
);

-- ============================================
-- IPHONE SYNC DEVICES TABLE (TASK-2121)
-- Tracks per-iPhone sync timestamps, separate from desktop `devices` table
-- ============================================
CREATE TABLE IF NOT EXISTS iphone_sync_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_udid TEXT NOT NULL,
  device_name TEXT,
  last_sync_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, device_udid)
);

-- ============================================
-- ANALYTICS EVENTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Event Data
  event_name TEXT NOT NULL,
  event_data JSONB,

  -- Context
  device_id TEXT,
  app_version TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- USER PREFERENCES SYNC TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- API USAGE TRACKING (Rate Limiting)
-- ============================================
CREATE TABLE IF NOT EXISTS api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  -- API Details
  api_name TEXT NOT NULL,
  endpoint TEXT,

  -- Cost Tracking
  estimated_cost DECIMAL(10, 4),

  -- Request Details
  request_data JSONB,
  response_status INTEGER,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES (Cloud Database)
-- ============================================
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_id);
CREATE INDEX IF NOT EXISTS idx_users_subscription ON users(subscription_status);
CREATE INDEX IF NOT EXISTS idx_licenses_user_id ON licenses(user_id);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_device_id ON devices(device_id);
CREATE INDEX IF NOT EXISTS idx_analytics_user_id ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_created_at ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_event_name ON analytics_events(event_name);
CREATE INDEX IF NOT EXISTS idx_api_usage_user_id ON api_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_created_at ON api_usage(created_at);

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE iphone_sync_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Service role has full access" ON users;
DROP POLICY IF EXISTS "Service role has full access" ON licenses;
DROP POLICY IF EXISTS "Service role has full access" ON devices;
DROP POLICY IF EXISTS "Service role has full access" ON iphone_sync_devices;
DROP POLICY IF EXISTS "Service role has full access" ON analytics_events;
DROP POLICY IF EXISTS "Service role has full access" ON user_preferences;
DROP POLICY IF EXISTS "Service role has full access" ON api_usage;

-- Policies (Allow all for service role - Electron uses service key)
CREATE POLICY "Service role has full access" ON users
  FOR ALL USING (true);

CREATE POLICY "Service role has full access" ON licenses
  FOR ALL USING (true);

CREATE POLICY "Service role has full access" ON devices
  FOR ALL USING (true);

CREATE POLICY "Service role has full access" ON iphone_sync_devices
  FOR ALL USING (true);

CREATE POLICY "Service role has full access" ON analytics_events
  FOR ALL USING (true);

CREATE POLICY "Service role has full access" ON user_preferences
  FOR ALL USING (true);

CREATE POLICY "Service role has full access" ON api_usage
  FOR ALL USING (true);

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
DROP TRIGGER IF EXISTS update_user_preferences_updated_at ON user_preferences;

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_preferences_updated_at BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
