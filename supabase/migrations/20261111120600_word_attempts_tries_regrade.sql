-- 21 · word_attempts: tries, re-grade history, graded_by check, link to the word
-- Phase 1, part 3. Columns and checks only; the rules that fill and protect
-- them are the grading-lock trigger (migration 22) and grade-answer.
--
-- word_attempts stays the FINAL result per student per word.
--
-- New columns:
--   tries                how many voice answers this student gave for this word
--                        (= the newest attempt_no in answer_attempts). Set by
--                        grade-answer. Existing rows that have a recording
--                        start at 1, all others at 0.
--   original_is_correct  \
--   original_graded_by    |  saved on the FIRST re-grade after the session
--   regraded_by           |  ended (migration 22), never changed after that.
--   regraded_at          /   Empty = never re-graded.
--
-- graded_by check (there was none; the data has only auto, missed, teacher):
--   null | 'auto' (voice) | 'teacher' | 'missed' (no answer) | 'skipped' (new)
-- original_graded_by gets the same check.
--
-- session_word_id → session_words(id), ON DELETE SET NULL (0 orphans, checked
-- 11 Nov 2026). Deleting a session deletes its session_words; the answers
-- here are kept with session_word_id and session_id empty, so the student's
-- progress and analytics don't change (teacher_student_stats counts a row
-- with no word id on its own, and there was only one row per word anyway).
-- The unique (session_word_id, student_id) index already serves the lookup.
--
-- Safe to run more than once.

begin;

alter table public.word_attempts
  add column if not exists tries               int not null default 0,
  add column if not exists original_is_correct boolean,
  add column if not exists original_graded_by  text,
  add column if not exists regraded_by         uuid,
  add column if not exists regraded_at         timestamptz;

update public.word_attempts
   set tries = 1
 where tries = 0 and audio_path is not null;

alter table public.word_attempts drop constraint if exists word_attempts_tries_check;
alter table public.word_attempts
  add constraint word_attempts_tries_check check (tries >= 0);

alter table public.word_attempts drop constraint if exists word_attempts_graded_by_check;
alter table public.word_attempts
  add constraint word_attempts_graded_by_check
  check (graded_by is null or graded_by in ('auto', 'teacher', 'missed', 'skipped'));

alter table public.word_attempts drop constraint if exists word_attempts_original_graded_by_check;
alter table public.word_attempts
  add constraint word_attempts_original_graded_by_check
  check (original_graded_by is null or original_graded_by in ('auto', 'teacher', 'missed', 'skipped'));

alter table public.word_attempts drop constraint if exists word_attempts_regraded_by_fkey;
alter table public.word_attempts
  add constraint word_attempts_regraded_by_fkey
  foreign key (regraded_by) references public.profiles (id) on delete set null;

alter table public.word_attempts drop constraint if exists word_attempts_session_word_id_fkey;
alter table public.word_attempts
  add constraint word_attempts_session_word_id_fkey
  foreign key (session_word_id) references public.session_words (id) on delete set null;

commit;

-- ── Check after running ──────────────────────────────────────────────────────
-- select conname, pg_get_constraintdef(oid) from pg_constraint
-- where conrelid = 'public.word_attempts'::regclass and contype in ('c', 'f') order by 1;
--   → word_attempts_graded_by_check, word_attempts_original_graded_by_check,
--     word_attempts_regraded_by_fkey, word_attempts_session_id_fkey,
--     word_attempts_session_word_id_fkey (ON DELETE SET NULL),
--     word_attempts_student_id_fkey, word_attempts_tries_check
-- select graded_by, tries, count(*) from public.word_attempts group by 1, 2 order by 1, 2;
--
-- ── ROLLBACK (only before migration 22) ──────────────────────────────────────
-- begin;
-- alter table public.word_attempts
--   drop constraint if exists word_attempts_session_word_id_fkey,
--   drop constraint if exists word_attempts_regraded_by_fkey,
--   drop constraint if exists word_attempts_original_graded_by_check,
--   drop constraint if exists word_attempts_graded_by_check,
--   drop constraint if exists word_attempts_tries_check,
--   drop column if exists regraded_at,
--   drop column if exists regraded_by,
--   drop column if exists original_graded_by,
--   drop column if exists original_is_correct,
--   drop column if exists tries;
-- commit;
