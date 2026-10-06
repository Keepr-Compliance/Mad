-- The migration seeds the production URL once and never replaces an existing secret.
DO $$ BEGIN
  PERFORM pg_temp.ok((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'submission_sweep_url')
                     = 'https://nercleijfrxqcvfjskbc.supabase.co/functions/v1/submission-sweep', 'S16 production URL seeded');
  PERFORM pg_temp.ok((SELECT count(*) FROM vault.secrets WHERE name IN ('submission_sweep_url', 'submission_sweep_secret')) = 2, 'S16 one row per secret');
END $$;
