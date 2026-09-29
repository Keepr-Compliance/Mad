-- BACKLOG-3547 stub: widens transaction_submissions with the nine commission
-- and split columns the BACKLOG-3519 migration (PR #2721, unapplied) adds, with
-- the same names and types, so c04 can prove the insert rule leaves them
-- unconstrained. No foreign key (split_agreement_id's target table is not part
-- of this prelude) and no CHECKs: the rule under test is the policy, not them.
-- Loaded inside the control's transaction; rolled back with it.
ALTER TABLE public.transaction_submissions
  ADD COLUMN IF NOT EXISTS commission_offered_rate      numeric(6,3),
  ADD COLUMN IF NOT EXISTS commission_actual_rate       numeric(6,3),
  ADD COLUMN IF NOT EXISTS commission_gross_amount      numeric(12,2),
  ADD COLUMN IF NOT EXISTS commission_adjustment_reason text,
  ADD COLUMN IF NOT EXISTS split_agreement_id           uuid,
  ADD COLUMN IF NOT EXISTS split_agent_pct              numeric(5,2),
  ADD COLUMN IF NOT EXISTS split_brokerage_pct          numeric(5,2),
  ADD COLUMN IF NOT EXISTS split_effective_from         date,
  ADD COLUMN IF NOT EXISTS split_resolved_on            date;

-- desk(id, org, uid, local_txn, status_sql, extra_cols, extra_vals): the
-- desktop's insert, transcribed from electron/services/submissionService.ts
-- mapToSubmission (:1381-1409) with the status override at :745. Every key the
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
