-- harness: apply-twice
-- Applying the migration twice keeps one secret of each name and the first secret value.
DO $$ BEGIN
  PERFORM pg_temp.ok((SELECT count(*) FROM vault.secrets WHERE name = 'submission_sweep_secret') = 1
                 AND (SELECT count(*) FROM vault.secrets WHERE name = 'submission_sweep_url') = 1, 'G2 one secret of each name');
  PERFORM pg_temp.ok((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'submission_sweep_secret') = current_setting('t3726.secret1'), 'G2 secret not regenerated');
END $$;
