-- Migration: Add legal document version tracking columns
-- Run this in your Supabase SQL editor

-- Add terms version column
ALTER TABLE users
ADD COLUMN IF NOT EXISTS terms_version_accepted TEXT;

-- Add privacy policy version column
ALTER TABLE users
ADD COLUMN IF NOT EXISTS privacy_policy_version_accepted TEXT;

-- Optional: Add comment for documentation
COMMENT ON COLUMN users.terms_version_accepted IS 'Version of Terms of Service that user accepted';
COMMENT ON COLUMN users.privacy_policy_version_accepted IS 'Version of Privacy Policy that user accepted';
