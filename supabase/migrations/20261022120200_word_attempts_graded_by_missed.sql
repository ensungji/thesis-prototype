-- 15 · "No answer" rows: graded_by = 'missed'
-- B-07. When a word ends and an assigned student (with a paired device) has
-- no answer for it, the app saves a row for them:
--   is_correct = false, needs_review = false, graded_by = 'missed'
-- It's written with ON CONFLICT (session_word_id, student_id) DO NOTHING
-- (the one-answer-per-word index from migration 04), so:
--   - an answer that's already there (voice or teacher) is never replaced
--   - a voice answer that arrives later replaces the "No answer" row
--     (grade-answer replaces any row that isn't the teacher's; no change needed)
--   - a teacher's grade on it sets graded_by = 'teacher' and then stands
-- Analytics (teacher_student_stats) counts it as wrong, like any other row.
--
-- This migration only matters if word_attempts has a CHECK on graded_by that
-- lists the allowed values (the repo can't see the live schema). If it does,
-- that check is replaced by one that also allows 'missed' (plus every value
-- already in the table, so no existing row breaks). If there's no such check,
-- nothing changes. Safe to run more than once.

begin;

do $$
declare
  c record;
  dropped int := 0;
  allowed text;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.word_attempts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%graded_by%'
  loop
    execute format('alter table public.word_attempts drop constraint %I', c.conname);
    dropped := dropped + 1;
  end loop;

  if dropped > 0 then
    select string_agg(quote_literal(v), ', ' order by v) into allowed
    from (
      select unnest(array['auto', 'teacher', 'missed']) as v
      union
      select distinct graded_by from public.word_attempts where graded_by is not null
    ) t;
    execute format(
      'alter table public.word_attempts add constraint word_attempts_graded_by_check
         check (graded_by is null or graded_by in (%s))', allowed);
  end if;
end $$;

commit;

-- ── Check after running ──────────────────────────────────────────────────────
-- select conname, pg_get_constraintdef(oid) from pg_constraint
-- where conrelid = 'public.word_attempts'::regclass and contype = 'c';
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Only needed if a check was replaced (the query above shows
-- word_attempts_graded_by_check). Remove the "No answer" rows first, then put
-- the old list back:
--   delete from public.word_attempts where graded_by = 'missed';
--   alter table public.word_attempts drop constraint word_attempts_graded_by_check;
--   alter table public.word_attempts add constraint word_attempts_graded_by_check
--     check (graded_by is null or graded_by in ('auto', 'teacher'));
