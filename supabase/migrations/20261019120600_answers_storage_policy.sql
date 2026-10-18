-- 06 · Recordings: a teacher can only play their own students' answers
-- Policy review finding 4 (AUDIT 3.6, children's voices).
--
-- grade-answer saves every recording at
--   answers/<session id>/<student id>/<timestamp>_<word>.<ext>
-- so the SECOND folder of the path is the student. The app plays recordings
-- through signed URLs, which need this SELECT permission.
-- students.id is compared as text, so a path that isn't a UUID can't raise
-- a cast error.
--
-- Check that every recording follows that format (expect 0):
--   select count(*) from storage.objects
--   where bucket_id = 'answers'
--     and coalesce((storage.foldername(name))[2], '') !~
--         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

drop policy if exists "teachers read answers" on storage.objects;

create policy "teachers read own students answers"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'answers'
    and exists (
      select 1 from public.students
      where students.teacher_id = auth.uid()
        and students.id::text = (storage.foldername(name))[2]
    )
  );

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop policy if exists "teachers read own students answers" on storage.objects;
-- create policy "teachers read answers" on storage.objects
--   for select to authenticated using (bucket_id = 'answers');
