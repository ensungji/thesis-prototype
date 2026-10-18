-- 11 · Analytics computed in the database
-- AUDIT 6.1. Used by app/(teacher)/analytics.tsx.
--
-- Fixes:
--   - no 1,000-row cap (the app fetched every attempt; the API returns at most 1,000)
--   - only the NEWEST answer per student per word counts (retries, hand +
--     voice grades of the same word no longer count twice)
--   - an answer whose newest version still needs review is skipped
--     (the newest version is picked first, then review rows are dropped, so an
--      older graded answer doesn't count in its place)
--   - streak = correct answers in a row, newest first, over the same answers
--     (same rule the app used: anything not marked correct ends the streak)
-- The class average across students is done in the app, over students that
-- have at least one answer.
--
-- Answers without a session_word_id (older rows) each count on their own.
-- SECURITY INVOKER: RLS applies, so a teacher only ever sees their own students.

create or replace function public.teacher_student_stats(p_since timestamptz default null)
returns table (
  student_id uuid,
  full_name text,
  total int,
  correct int,
  avg_response_ms int,
  streak int
)
language sql
stable
security invoker
set search_path = public
as $$
  with newest as (
    select distinct on (a.student_id, coalesce(a.session_word_id::text, a.id::text))
           a.student_id, a.is_correct, a.response_time_ms, a.attempted_at, a.needs_review
    from word_attempts a
    where p_since is null or a.attempted_at >= p_since
    order by a.student_id, coalesce(a.session_word_id::text, a.id::text), a.attempted_at desc, a.id desc
  ),
  counted as (
    select * from newest where coalesce(needs_review, false) = false
  ),
  last_miss as (
    select c.student_id, max(c.attempted_at) as at
    from counted c
    where c.is_correct is not true
    group by c.student_id
  )
  select s.id,
         s.full_name::text,
         count(c.student_id)::int,
         (count(*) filter (where c.is_correct))::int,
         coalesce(round(avg(c.response_time_ms) filter (where c.response_time_ms > 0)), 0)::int,
         (count(c.student_id) filter (
            where m.at is null or c.attempted_at > m.at
         ))::int
  from students s
  left join counted c on c.student_id = s.id
  left join last_miss m on m.student_id = s.id
  where s.teacher_id = auth.uid()
  group by s.id, s.full_name
  order by s.full_name;
$$;

revoke execute on function public.teacher_student_stats(timestamptz) from public, anon;
grant  execute on function public.teacher_student_stats(timestamptz) to authenticated;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop function if exists public.teacher_student_stats(timestamptz);
