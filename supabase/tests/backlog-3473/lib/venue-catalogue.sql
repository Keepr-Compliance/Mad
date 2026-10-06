-- BACKLOG-3473: load production's plan / feature catalogue onto a SCHEMA-ONLY
-- test venue (run.sh catalogue-seed). COMMITTED. For the venue only -- never
-- production.
--
-- Why: the NAS stack holds production's schema and no rows. The fixtures need
-- admin_permissions.plans.manage, the controls rest on feature_definitions'
-- min_tier and on plan_features, migration 2 joins its plan rows by slug, and
-- the PostgREST probe's committed seed looks plans up by slug. Without this
-- file the gate fails on 129 catalogue rows and every control is void.
--
-- Transcribed from production, read-only, 2026-09-21. Every column a gate row
-- or one of the three read functions reads is copied exactly: feature key,
-- name, value_type, default_value, category, sort_order, min_tier, is_built;
-- plan slug, name, tier, is_default, is_active, sort_order; plan_features
-- enabled and value; the plans.manage key, label and category. `description`
-- is read by nothing under test and is left NULL. Ids are generated here --
-- nothing looks a catalogue row up by id.
--
-- Refuses unless all four tables are empty, then re-hashes what it wrote
-- against production's md5s and raises (rolling back) on any difference.
-- lib/venue-catalogue-teardown.sql removes exactly this set again.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $refuse$
DECLARE
  n bigint;
BEGIN
  SELECT (SELECT count(*) FROM public.feature_definitions) + (SELECT count(*) FROM public.plans)
       + (SELECT count(*) FROM public.plan_features) + (SELECT count(*) FROM public.admin_permissions)
    INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'catalogue-seed refused: the venue already holds % catalogue row(s)', n;
  END IF;
END
$refuse$;

INSERT INTO public.feature_definitions (key, name, value_type, default_value, category, sort_order, min_tier, is_built) VALUES
  ('ai_detection',              'AI Detection',                'boolean', 'false', 'general',    160, NULL,         true),
  ('broker_email_attachments',  'Broker Email Attachments',    'boolean', 'false', 'export',      40, NULL,         true),
  ('broker_email_view',         'Broker Email View',           'boolean', 'true',  'export',      20, NULL,         true),
  ('broker_portal_access',      'Broker Portal Access',        'boolean', 'false', 'access',     125, 'team',       true),
  ('broker_submission',         'Broker Submission',           'boolean', 'false', 'access',     130, 'team',       true),
  ('broker_text_attachments',   'Broker Text Attachments',     'boolean', 'false', 'export',      30, NULL,         true),
  ('broker_text_view',          'Broker Text View',            'boolean', 'true',  'export',      10, NULL,         true),
  ('call_log',                  'Call Log Access',             'boolean', 'false', 'sync',        50, 'team',       true),
  ('custom_retention',          'Custom Retention Period',     'boolean', 'false', 'compliance', 100, 'enterprise', true),
  ('desktop_email_attachments', 'Desktop Email Attachments',   'boolean', 'false', 'export',      45, NULL,         true),
  ('desktop_email_export',      'Desktop Email Export',        'boolean', 'false', 'export',      25, NULL,         true),
  ('desktop_hide_from_export',  'Hide from export',            'boolean', 'false', 'export',      46, NULL,         true),
  ('desktop_text_attachments',  'Desktop Text Attachments',    'boolean', 'false', 'export',      35, NULL,         true),
  ('desktop_text_export',       'Desktop Text Export',         'boolean', 'false', 'export',      15, NULL,         true),
  ('email_contact_inference',   'Contacts from email',         'boolean', 'false', 'general',    161, NULL,         false),
  ('email_sync',                'Email Sync',                  'boolean', 'true',  'sync',        80, NULL,         true),
  ('iphone_sync',               'iPhone Sync',                 'boolean', 'true',  'sync',        70, NULL,         true),
  ('jit_provisioning',          'Just-in-Time Provisioning',   'boolean', 'false', 'access',     156, NULL,         false),
  ('max_seats',                 'Maximum Seats',               'integer', 'false', 'access',       0, NULL,         true),
  ('max_transaction_size',      'Max Transaction Size',        'integer', '10',    'compliance',  60, NULL,         true),
  ('multi_seat',                'Multi-Seat',                  'boolean', 'false', 'access',     150, 'team',       true),
  ('scim_provisioning',         'SCIM Provisioning',           'boolean', 'false', 'access',     155, NULL,         false),
  ('sso_login',                 'SSO Login',                   'boolean', 'false', 'general',    120, 'enterprise', true),
  ('team_management',           'Team Management',             'boolean', 'false', 'access',     140, 'team',       true),
  ('voice_transcription',       'Voice Message Transcription', 'boolean', 'false', 'sync',        90, 'team',       true);

INSERT INTO public.plans (name, slug, tier, is_default, is_active, sort_order) VALUES
  ('Enterprise',     'enterprise',     'enterprise', false, true, 30),
  ('Individual',     'individual',     'individual', true,  true, 10),
  ('Keepr Internal', 'keepr-internal', 'enterprise', false, true, 40),
  ('Team',           'team',           'team',       false, true, 20);

INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
SELECT p.id, fd.id, v.enabled, v.value
  FROM (VALUES
    ('enterprise', 'ai_detection', false, NULL),
    ('enterprise', 'broker_email_attachments', true, NULL),
    ('enterprise', 'broker_email_view', true, NULL),
    ('enterprise', 'broker_portal_access', true, NULL),
    ('enterprise', 'broker_submission', true, NULL),
    ('enterprise', 'broker_text_attachments', true, NULL),
    ('enterprise', 'broker_text_view', true, 'true'),
    ('enterprise', 'call_log', true, NULL),
    ('enterprise', 'custom_retention', true, NULL),
    ('enterprise', 'desktop_email_attachments', true, NULL),
    ('enterprise', 'desktop_email_export', true, NULL),
    ('enterprise', 'desktop_hide_from_export', false, 'false'),
    ('enterprise', 'desktop_text_attachments', true, NULL),
    ('enterprise', 'desktop_text_export', true, NULL),
    ('enterprise', 'email_contact_inference', true, 'true'),
    ('enterprise', 'email_sync', true, NULL),
    ('enterprise', 'iphone_sync', true, NULL),
    ('enterprise', 'jit_provisioning', false, 'false'),
    ('enterprise', 'max_seats', true, '50'),
    ('enterprise', 'max_transaction_size', true, '1000'),
    ('enterprise', 'multi_seat', true, NULL),
    ('enterprise', 'scim_provisioning', false, 'false'),
    ('enterprise', 'sso_login', true, NULL),
    ('enterprise', 'team_management', true, NULL),
    ('enterprise', 'voice_transcription', true, NULL),
    ('individual', 'ai_detection', false, NULL),
    ('individual', 'broker_email_attachments', false, NULL),
    ('individual', 'broker_email_view', false, NULL),
    ('individual', 'broker_portal_access', false, NULL),
    ('individual', 'broker_submission', false, NULL),
    ('individual', 'broker_text_attachments', false, NULL),
    ('individual', 'broker_text_view', false, NULL),
    ('individual', 'call_log', false, NULL),
    ('individual', 'custom_retention', false, NULL),
    ('individual', 'desktop_email_attachments', true, NULL),
    ('individual', 'desktop_email_export', true, NULL),
    ('individual', 'desktop_hide_from_export', false, 'false'),
    ('individual', 'desktop_text_attachments', true, NULL),
    ('individual', 'desktop_text_export', true, NULL),
    ('individual', 'email_contact_inference', true, 'true'),
    ('individual', 'email_sync', true, NULL),
    ('individual', 'iphone_sync', true, NULL),
    ('individual', 'jit_provisioning', false, 'false'),
    ('individual', 'max_seats', true, '1'),
    ('individual', 'max_transaction_size', true, '10'),
    ('individual', 'multi_seat', false, NULL),
    ('individual', 'scim_provisioning', false, 'false'),
    ('individual', 'sso_login', false, NULL),
    ('individual', 'team_management', false, NULL),
    ('individual', 'voice_transcription', false, NULL),
    ('keepr-internal', 'ai_detection', false, 'false'),
    ('keepr-internal', 'broker_email_attachments', false, 'false'),
    ('keepr-internal', 'broker_email_view', false, 'true'),
    ('keepr-internal', 'broker_portal_access', false, 'false'),
    ('keepr-internal', 'broker_submission', false, 'false'),
    ('keepr-internal', 'broker_text_attachments', false, 'false'),
    ('keepr-internal', 'broker_text_view', false, 'true'),
    ('keepr-internal', 'call_log', false, 'false'),
    ('keepr-internal', 'custom_retention', false, 'false'),
    ('keepr-internal', 'desktop_email_attachments', true, 'false'),
    ('keepr-internal', 'desktop_email_export', true, 'false'),
    ('keepr-internal', 'desktop_hide_from_export', false, 'false'),
    ('keepr-internal', 'desktop_text_attachments', true, 'false'),
    ('keepr-internal', 'desktop_text_export', true, 'false'),
    ('keepr-internal', 'email_contact_inference', true, 'true'),
    ('keepr-internal', 'email_sync', true, 'true'),
    ('keepr-internal', 'iphone_sync', true, 'true'),
    ('keepr-internal', 'jit_provisioning', false, 'false'),
    ('keepr-internal', 'max_seats', true, '1'),
    ('keepr-internal', 'max_transaction_size', true, '10'),
    ('keepr-internal', 'multi_seat', false, 'false'),
    ('keepr-internal', 'scim_provisioning', false, 'false'),
    ('keepr-internal', 'sso_login', false, 'false'),
    ('keepr-internal', 'team_management', false, 'false'),
    ('keepr-internal', 'voice_transcription', false, 'false'),
    ('team', 'ai_detection', false, NULL),
    ('team', 'broker_email_attachments', true, NULL),
    ('team', 'broker_email_view', true, NULL),
    ('team', 'broker_portal_access', true, NULL),
    ('team', 'broker_submission', true, NULL),
    ('team', 'broker_text_attachments', true, NULL),
    ('team', 'broker_text_view', true, NULL),
    ('team', 'call_log', true, NULL),
    ('team', 'custom_retention', false, NULL),
    ('team', 'desktop_email_attachments', true, NULL),
    ('team', 'desktop_email_export', true, NULL),
    ('team', 'desktop_hide_from_export', false, 'false'),
    ('team', 'desktop_text_attachments', true, NULL),
    ('team', 'desktop_text_export', true, NULL),
    ('team', 'email_contact_inference', true, 'true'),
    ('team', 'email_sync', true, NULL),
    ('team', 'iphone_sync', true, NULL),
    ('team', 'jit_provisioning', false, 'false'),
    ('team', 'max_seats', true, '5'),
    ('team', 'max_transaction_size', true, '100'),
    ('team', 'multi_seat', true, NULL),
    ('team', 'scim_provisioning', false, 'false'),
    ('team', 'sso_login', false, NULL),
    ('team', 'team_management', true, NULL),
    ('team', 'voice_transcription', true, NULL)
  ) v(slug, key, enabled, value)
  JOIN public.plans p ON p.slug = v.slug
  JOIN public.feature_definitions fd ON fd.key = v.key;

INSERT INTO public.admin_permissions (key, label, category) VALUES
  ('plans.manage', 'Manage Plans', 'plans');

\ir venue-catalogue-verify.sql

COMMIT;
