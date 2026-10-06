-- H2: own-folder 3-segment (2.38-style) path: inserted
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
INSERT INTO public.submission_attachments (submission_id, filename, storage_path) VALUES (:'S', 'p', :'ORG' || '/' || :'S' || '/photo.jpg');
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) FROM public.submission_attachments WHERE submission_id = :'S') = 2, 'H2 inserted');
