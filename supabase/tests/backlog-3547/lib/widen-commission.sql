-- BACKLOG-3547 stub: widens transaction_submissions with the four commission
-- columns the BACKLOG-3519 migration adds
-- (supabase/migrations/20260925070000_backlog_3519_commission_figures.sql,
-- PR #2721), with the same names and types, so c04 can prove the insert rule
-- leaves them unconstrained. 3519 adds no split columns. No CHECKs and no lock
-- trigger (the trigger fires on UPDATE only): the rule under test is the
-- policy. The real file is not loaded here because it carries its own
-- BEGIN/COMMIT, which would end the control's rolled-back transaction.
-- Loaded inside the control's transaction; rolled back with it.
ALTER TABLE public.transaction_submissions
  ADD COLUMN IF NOT EXISTS commission_offered_rate      numeric(6,3),
  ADD COLUMN IF NOT EXISTS commission_actual_rate       numeric(6,3),
  ADD COLUMN IF NOT EXISTS commission_gross_amount      numeric(12,2),
  ADD COLUMN IF NOT EXISTS commission_adjustment_reason text;

-- desk(id, org, uid, local_txn, status_sql, extra_cols, extra_vals): the
-- desktop's insert, transcribed from electron/services/submissionService.ts
-- mapToSubmission (:1533-1596) with the status override at :886. Every key the
-- desktop sends is present; undefined keys (property_city etc. when blank) are
-- omitted by supabase-js, so the transcription sends them populated.
-- status_sql is a SQL literal ('uploading', NULL, ...) or '' to omit status.
CREATE FUNCTION pg_temp.desk(p_id uuid, p_org uuid, p_uid uuid, p_txn text, p_status text,
                             p_cols text DEFAULT '', p_vals text DEFAULT '') RETURNS text
LANGUAGE sql AS $$
  SELECT format(
    'INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, '
    'property_address, property_city, property_state, property_zip, transaction_type, listing_price, sale_price, '
    'started_at, closed_at, version, message_count, attachment_count, submission_metadata%s%s) '
    'VALUES (%L, %L, %L, %L, ''47 Fixture Way'', ''Fixtureville'', ''CA'', ''90000'', ''purchase'', 500000, 495000, '
    '''2026-08-01T00:00:00.000Z'', ''2026-09-01T00:00:00.000Z'', 1, 3, 1, '
    '''{"desktop_version": "2.38.1", "detection_source": "manual", "detection_confidence": null}''::jsonb%s%s)',
    CASE WHEN p_status = '' THEN '' ELSE ', status' END, p_cols,
    p_id, p_org, p_uid, p_txn,
    CASE WHEN p_status = '' THEN '' ELSE ', ' || p_status END, p_vals)
$$;
