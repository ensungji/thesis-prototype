-- 05 · word_attempts: only your own students' answers can be written
-- Policy review finding 3.
--
-- Postgres ORs permissive policies together, so these two "true" policies let
-- any teacher insert or regrade ANY student's answers, whatever the scoped
-- policies next to them say:
--   "teachers grade attempts"  (UPDATE, true / true)
--   "teachers insert attempts" (INSERT, true)
--
-- Still allowed after this:
--   - grade-answer writes with the service role, which bypasses RLS.
--   - The app's hand grade: an INSERT ... ON CONFLICT DO NOTHING (checked by
--     the existing "Teachers can insert own word attempts"), then an UPDATE
--     matched on (session_word_id, student_id), checked by the new policy below.
--   - Overriding a voice grade: an UPDATE by id, checked by the new policy.

drop policy if exists "teachers grade attempts" on public.word_attempts;
drop policy if exists "teachers insert attempts" on public.word_attempts;

create policy "Teachers can update own word attempts"
  on public.word_attempts
  for update
  to authenticated
  using (
    exists (
      select 1 from public.students
      where students.id = word_attempts.student_id
        and students.teacher_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.students
      where students.id = word_attempts.student_id
        and students.teacher_id = auth.uid()
    )
  );

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop policy if exists "Teachers can update own word attempts" on public.word_attempts;
-- create policy "teachers grade attempts" on public.word_attempts
--   for update to authenticated using (true) with check (true);
-- create policy "teachers insert attempts" on public.word_attempts
--   for insert to authenticated with check (true);
