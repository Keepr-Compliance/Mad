-- C6: second call after success: already_final, still one history entry
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT public.finalize_submission(:'S', pg_temp.mf());
SELECT pg_temp.ok((r->>'ok')::boolean AND (r->>'already_final')::boolean, 'C6 ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
RESET ROLE;
SELECT pg_temp.ok(jsonb_array_length(status_history) = 1, 'C6 history ' || jsonb_array_length(status_history)) FROM public.transaction_submissions WHERE id = :'S';
