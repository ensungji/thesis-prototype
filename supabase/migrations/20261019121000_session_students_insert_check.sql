-- 10 · Assigning a student to a session: the student must be yours too
-- Policy review finding 7.
--
-- The INSERT check only looked at the session, so a teacher could add another
-- teacher's student (by UUID) to their own session.

drop policy if exists "Teachers can insert own session students" on public.session_students;

create policy "Teachers can insert own session students"
  on public.session_students
  for insert
  to public
  with check (
    exists (
      select 1 from public.sessions
      where sessions.id = session_students.session_id
        and sessions.teacher_id = auth.uid()
    )
    and exists (
      select 1 from public.students
      where students.id = session_students.student_id
        and students.teacher_id = auth.uid()
    )
  );

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop policy if exists "Teachers can insert own session students" on public.session_students;
-- create policy "Teachers can insert own session students" on public.session_students
--   for insert to public
--   with check (exists (select 1 from sessions
--                       where sessions.id = session_students.session_id
--                         and sessions.teacher_id = auth.uid()));
