-- 20 · answer_attempts: every voice answer is kept
-- Phase 1, part 3.
--
-- word_attempts stays ONE row per student per word: the final result the app
-- and analytics use. answer_attempts gets a row for EVERY voice answer
-- (try 1, 2, 3, ...), including answers that arrive after the word is
-- already correct and locked. Written only by grade-answer (service role).
--
--   attempt_no   1, 2, 3 ... per student per word (unique)
--   result       what grade-answer returned for that try:
--                'correct' | 'wrong' | 'review'
--   audio_path   the recording in the "answers" bucket (same path format as
--                word_attempts: <session>/<student>/<timestamp>_<word>.<ext>)
--
-- Who can read: the session's teacher, and admins. Nobody can write through
-- the API (no insert / update / delete policies, and the rights are revoked);
-- the service role bypasses RLS.
--
-- Deleting: a deleted session deletes its session_words, and with them these
-- rows (ON DELETE CASCADE), so this table never blocks Delete session. The
-- final results in word_attempts stay (migration 21), and the recordings stay
-- in storage. Deleting a student deletes theirs too, like word_attempts.

begin;

create table public.answer_attempts (
  id               uuid primary key default gen_random_uuid(),
  session_word_id  uuid not null references public.session_words (id) on delete cascade,
  student_id       uuid not null references public.students (id) on delete cascade,
  attempt_no       int  not null
                   constraint answer_attempts_attempt_no_check check (attempt_no >= 1),
  audio_path       text,
  transcript       text,
  result           text not null
                   constraint answer_attempts_result_check check (result in ('correct', 'wrong', 'review')),
  confidence       real,
  response_time_ms int,
  created_at       timestamptz not null default now(),
  constraint answer_attempts_one_per_try unique (session_word_id, student_id, attempt_no)
);

-- deleting a student finds their rows by student_id
create index answer_attempts_student_id_idx on public.answer_attempts (student_id);

alter table public.answer_attempts enable row level security;

revoke all on public.answer_attempts from anon;
revoke insert, update, delete, truncate on public.answer_attempts from authenticated;
grant  select on public.answer_attempts to authenticated;
grant  select, insert, update, delete on public.answer_attempts to service_role;

create policy "Teachers can read their sessions' answer attempts"
  on public.answer_attempts for select to authenticated
  using (exists (
    select 1
    from public.session_words sw
    join public.sessions s on s.id = sw.session_id
    where sw.id = answer_attempts.session_word_id
      and s.teacher_id = auth.uid()
  ));

create policy "Admins can read answer attempts"
  on public.answer_attempts for select to authenticated
  using (public.is_admin());

commit;

-- ── Check after running ──────────────────────────────────────────────────────
-- select policyname, cmd from pg_policies where tablename = 'answer_attempts';   -- 2 rows, both SELECT
-- select privilege_type from information_schema.role_table_grants
-- where table_name = 'answer_attempts' and grantee = 'authenticated';             -- SELECT only
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop table if exists public.answer_attempts;
