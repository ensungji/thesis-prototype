-- 23 · "Done reviewing" + speech grading agreement
-- Phase 4.
--
-- sessions.reviewed_at: set when the teacher taps "Done reviewing" on the
-- review screen. It tells "the teacher agreed with the speech grading" apart
-- from "the teacher never looked": only reviewed sessions are counted.
-- Only a finished session can be marked reviewed (check below). Teachers
-- write it through the existing "Teachers can update own sessions" policy.
--
-- speech_grading_agreement(): totals over every reviewed session, for the
-- admin panel (admins can't read word_attempts directly). Admin only.
-- The same rule as speechAgreement() in mobile/lib/review.ts:
--   voice answer  = graded by voice when the session ended: graded_by 'auto'
--                   and never re-graded, or re-graded from 'auto'
--                   (original_graded_by, migration 22)
--   still_review  = still 'auto' + needs_review, never re-graded: nobody
--                   decided, so it's left out of voice_answers
--   agreed        = never re-graded, or re-graded to the same is_correct
--   disagreed     = voice_answers - agreed (re-graded to a different result)
-- Note: a re-graded row keeps original_is_correct, not whether it was a
-- 'review' row, so a review row the teacher resolved counts as agreed when
-- the teacher's answer matches what the speech grading heard (is_correct).

begin;

alter table public.sessions add column if not exists reviewed_at timestamptz;

alter table public.sessions drop constraint if exists sessions_reviewed_only_finished;
alter table public.sessions
  add constraint sessions_reviewed_only_finished
  check (reviewed_at is null or status = 'finished');

create or replace function public.speech_grading_agreement()
returns table (reviewed_sessions int, voice_answers int, agreed int, still_review int)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can see this' using errcode = '42501';
  end if;

  return query
  with reviewed as (
    select s.id from sessions s where s.reviewed_at is not null
  ),
  voice as (
    select wa.is_correct,
           wa.original_is_correct,
           wa.regraded_at is not null as regraded,
           coalesce(wa.needs_review, false) as needs_review
    from word_attempts wa
    join reviewed r on r.id = wa.session_id
    where (wa.regraded_at is null and wa.graded_by = 'auto')
       or (wa.regraded_at is not null and wa.original_graded_by = 'auto')
  )
  select (select count(*) from reviewed)::int,
         (count(*) filter (where v.regraded or not v.needs_review))::int,
         (count(*) filter (where (not v.regraded and not v.needs_review)
                              or (v.regraded and v.is_correct = v.original_is_correct)))::int,
         (count(*) filter (where not v.regraded and v.needs_review))::int
  from voice v;
end;
$$;

revoke execute on function public.speech_grading_agreement() from public, anon;
grant  execute on function public.speech_grading_agreement() to authenticated;

commit;

-- ── Check after running ──────────────────────────────────────────────────────
-- select count(*) filter (where reviewed_at is not null) as reviewed, count(*) from public.sessions;
--   → reviewed 0
-- select public.speech_grading_agreement();
--   → error "Only an admin can see this" (the SQL editor isn't an admin)
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- begin;
-- drop function if exists public.speech_grading_agreement();
-- alter table public.sessions drop constraint if exists sessions_reviewed_only_finished;
-- alter table public.sessions drop column if exists reviewed_at;
-- commit;
