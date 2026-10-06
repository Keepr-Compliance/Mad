-- E1: excluded_files written by the agent: finalize ignores them and keeps them
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
UPDATE public.transaction_submissions SET submission_metadata = '{"excluded_files": [{"filename": "big.mov", "source_message_id": "local-9", "reason": "file_too_large"}]}' WHERE id = :'S';
SELECT pg_temp.ok((r->>'ok')::boolean, 'E1 ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
RESET ROLE;
SELECT pg_temp.ok(jsonb_array_length(submission_metadata->'excluded_files') = 1 AND submission_metadata->>'finalized_by' = 'finalize_submission',
                  'E1 metadata ' || submission_metadata::text) FROM public.transaction_submissions WHERE id = :'S';
