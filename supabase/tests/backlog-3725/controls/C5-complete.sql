-- C5: complete manifest: submitted, one history entry, server counts, metadata stamped
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'ok')::boolean AND (r->>'status') = 'submitted' AND NOT (r->>'already_final')::boolean, 'C5 ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
RESET ROLE;
SELECT pg_temp.ok(status = 'submitted' AND jsonb_array_length(status_history) = 1 AND message_count = 2 AND attachment_count = 1
                  AND submission_metadata->>'finalized_by' = 'finalize_submission' AND status_history->0->>'changed_by' IS NULL,
                  'C5 row ' || status || ' h=' || jsonb_array_length(status_history) || ' mc=' || message_count || ' ac=' || attachment_count)
  FROM public.transaction_submissions WHERE id = :'S';
