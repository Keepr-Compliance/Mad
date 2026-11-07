-- Rollback for 20261105160000_backlog_4130_email_precache_report_access.
-- Restores the 20261105110000 (BACKLOG-4144 M2) policy text and comment, then removes the catalog key.
-- Removing the key CASCADEs to any public.report_access rows granted on 'email-precache'
-- (report_access.report_key REFERENCES public.reports ON DELETE CASCADE).

ALTER POLICY "Internal roles can read sync outcomes" ON public.sync_outcomes
  USING (
    (
      source = 'iphone-backup'
      AND (SELECT public.report_my_access('iphone-sync')) IS NOT NULL
    )
    OR (
      source = 'google-messages'
      AND (SELECT public.report_my_access('google-messages-sync')) IS NOT NULL
    )
  );

COMMENT ON POLICY "Internal roles can read sync outcomes" ON public.sync_outcomes IS
  'BACKLOG-4144: iphone-backup rows to iphone-sync report access; google-messages rows to google-messages-sync report access.';

DELETE FROM public.reports WHERE report_key = 'email-precache';
