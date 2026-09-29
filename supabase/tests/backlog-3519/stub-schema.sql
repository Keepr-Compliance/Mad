-- Minimal stand-in schema so 3519's migration can be executed on a bare
-- Postgres, outside the real Supabase project. Test scaffolding only.
-- The migration references ONE object: public.transaction_submissions.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);

-- Minimal stand-in for the real transaction_submissions (20260122_b2b_broker_portal.sql).
CREATE TABLE public.transaction_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  submitted_by uuid NOT NULL REFERENCES auth.users(id),
  local_transaction_id text NOT NULL,
  property_address text NOT NULL,
  listing_price numeric,
  sale_price numeric,
  status varchar(50) DEFAULT 'submitted',
  version integer DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
