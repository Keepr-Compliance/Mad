-- ============================================
-- SUPPORT TICKETING: STORAGE BUCKET
-- Migration: 20260313_support_storage
-- Purpose: Create support-attachments storage bucket with RLS policies
-- Sprint: SPRINT-130 / TASK-2171
-- ============================================
-- Path convention: {ticket_id}/{attachment_id}/{filename}
-- Agents (internal_roles) can read/write all
-- Customers can read attachments for their own tickets
-- Anon users can upload (for the public form)
-- 10MB file size limit (enforced application-side)
-- ============================================

-- Create the bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'support-attachments',
  'support-attachments',
  false,
  10485760,  -- 10MB in bytes
  ARRAY[
    'application/pdf',
    'application/json',  -- BACKLOG-1916: diagnostics.json for in-app support tickets
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp',
    'text/plain',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'video/mp4',
    'video/quicktime',
    'application/zip'
  ]
);

-- ============================================
-- SELECT: Agents can read all support attachments
-- ============================================
CREATE POLICY "Agents can read all support attachments"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'support-attachments'
  AND EXISTS (SELECT 1 FROM internal_roles WHERE user_id = auth.uid())
);

-- ============================================
-- SELECT: Customers can read attachments for their own tickets
-- ============================================
CREATE POLICY "Customers can read own ticket attachments"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'support-attachments'
  AND EXISTS (
    SELECT 1 FROM support_tickets t
    WHERE t.id::text = split_part(name, '/', 1)
    AND (
      t.requester_id = auth.uid()
      OR t.requester_email = (SELECT email FROM auth.users WHERE id = auth.uid())
    )
  )
);

-- ============================================
-- INSERT: Agents can upload to any support ticket
-- ============================================
CREATE POLICY "Agents can upload support attachments"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'support-attachments'
  AND EXISTS (SELECT 1 FROM internal_roles WHERE user_id = auth.uid())
);

-- ============================================
-- INSERT: Authenticated customers can upload to their own tickets
-- ============================================
CREATE POLICY "Customers can upload to own tickets"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'support-attachments'
  AND EXISTS (
    SELECT 1 FROM support_tickets t
    WHERE t.id::text = split_part(name, '/', 1)
    AND (
      t.requester_id = auth.uid()
      OR t.requester_email = (SELECT email FROM auth.users WHERE id = auth.uid())
    )
  )
);

-- ============================================
-- INSERT: Anon users can upload (for the public form)
-- The ticket_id in the path is validated application-side
-- ============================================
CREATE POLICY "Anon users can upload support attachments"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'support-attachments'
  AND auth.uid() IS NULL
);

-- ============================================
-- DELETE: Only agents can delete support attachments
-- ============================================
CREATE POLICY "Agents can delete support attachments"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'support-attachments'
  AND EXISTS (SELECT 1 FROM internal_roles WHERE user_id = auth.uid())
);
