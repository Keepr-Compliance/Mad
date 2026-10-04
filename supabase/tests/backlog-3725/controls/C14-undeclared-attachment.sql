-- C14: an undeclared attachment row: incomplete
INSERT INTO public.submission_attachments (id, submission_id, filename, storage_path) VALUES (:'AT2', :'S', 'photo.jpg', :'P2');
INSERT INTO storage.objects (bucket_id, name) VALUES ('submission-attachments', :'P2');
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'code') = 'incomplete' AND (r->>'attachment_rows_extra')::int = 1, 'C14 ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
