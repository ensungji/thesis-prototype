-- 22 · Grading lock on word_attempts (every session type)
-- Phase 1, part 4.
--
-- Terms used below:
--   voice row      graded_by = 'auto' (written by grade-answer)
--   voice-correct  graded_by = 'auto' AND is_correct AND NOT needs_review
--                  (a 'review' row with is_correct = true does NOT count)
--   active         the session's status is anything but 'finished'
--                  (pending, in_progress, paused). A row whose session is
--                  gone counts as ended.
--   teacher        a signed-in user (auth.uid() set). RLS already limits them
--                  to their own students' rows.
--   device         no signed-in user: grade-answer (service role) or the SQL editor
--
-- ── Device (grade-answer) ────────────────────────────────────────────────────
--   - A new voice answer replaces a wrong / review / missed / skipped result,
--     as many times as needed (unlimited retries).
--   - Once a row is voice-correct, a later VOICE answer (graded_by stays
--     'auto') can't change it, in any session state. Only tries may still go
--     up (the answer itself is kept in answer_attempts). Refused with
--     SQLSTATE DT001, which grade-answer turns into "locked": true.
--   - A teacher's grade is kept by grade-answer itself (unchanged from v6).
--
-- ── Teacher ──────────────────────────────────────────────────────────────────
--   - Can't create a voice row (graded_by 'auto', also the column default),
--     and can't turn a row into one.
--   - Can only change the grade: is_correct, needs_review, graded_by.
--     Changing anything else (word, student, session, transcript, recording,
--     ...) is refused. tries and the four re-grade columns are kept as they
--     were, whatever the app sends.
--   - Session active: voice rows (correct, wrong AND review) are locked.
--     Teacher / missed / skipped rows stay editable.
--   - Session ended: anything can be re-graded. A teacher's change to a voice
--     row is saved as graded_by = 'teacher'. The FIRST re-grade after the
--     end saves original_is_correct, original_graded_by, regraded_by and
--     regraded_at; they never change after that.
--
-- ── Everyone ─────────────────────────────────────────────────────────────────
--   - The four re-grade columns can't be written directly (empty on insert,
--     kept on update), except by this trigger.
--   - Foreign-key clean-up is always allowed: when a session, a session word
--     or a profile is deleted, emptying session_id / session_word_id /
--     regraded_by is let through (it only passes if that row really is gone,
--     so a teacher can't empty session_id to get around the lock).
--
-- Runs BEFORE INSERT / UPDATE, so the existing AFTER trigger
-- trg_log_teacher_grade only sees changes that were allowed.

create or replace function public.word_attempts_grading_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_rest   word_attempts%rowtype;
  v_active boolean;
begin
  -- ── INSERT ────────────────────────────────────────────────────────────────
  if tg_op = 'INSERT' then
    new.original_is_correct := null;
    new.original_graded_by  := null;
    new.regraded_by         := null;
    new.regraded_at         := null;
    if v_uid is not null then
      if new.graded_by is not distinct from 'auto' then
        raise exception 'Only the device can save a voice grade' using errcode = '42501';
      end if;
      new.tries := 0;
    end if;
    return new;
  end if;

  -- ── UPDATE: foreign-key clean-up (a deleted session / word / profile) ─────
  v_rest := new;
  if old.session_id is not null and new.session_id is null
     and not exists (select 1 from sessions where id = old.session_id) then
    v_rest.session_id := old.session_id;
  end if;
  if old.session_word_id is not null and new.session_word_id is null
     and not exists (select 1 from session_words where id = old.session_word_id) then
    v_rest.session_word_id := old.session_word_id;
  end if;
  if old.regraded_by is not null and new.regraded_by is null
     and not exists (select 1 from profiles where id = old.regraded_by) then
    v_rest.regraded_by := old.regraded_by;
  end if;
  if new is distinct from old and v_rest is not distinct from old then
    return new;
  end if;

  -- ── UPDATE: re-grade columns are only written below ───────────────────────
  new.original_is_correct := old.original_is_correct;
  new.original_graded_by  := old.original_graded_by;
  new.regraded_by         := old.regraded_by;
  new.regraded_at         := old.regraded_at;

  -- ── UPDATE by the device (grade-answer) or the SQL editor ─────────────────
  if v_uid is null then
    if old.graded_by = 'auto' and old.is_correct and not coalesce(old.needs_review, false)
       and new.graded_by is not distinct from 'auto' then
      v_rest := new;
      v_rest.tries := old.tries;
      if v_rest is distinct from old then
        raise exception 'This word is already correct; a later voice answer can''t replace it'
          using errcode = 'DT001';
      end if;
    end if;
    return new;
  end if;

  -- ── UPDATE by a teacher ───────────────────────────────────────────────────
  new.tries := old.tries;

  v_rest := new;
  v_rest.is_correct   := old.is_correct;
  v_rest.needs_review := old.needs_review;
  v_rest.graded_by    := old.graded_by;
  if v_rest is distinct from old then
    raise exception 'A teacher can only change the grade (is_correct, needs_review, graded_by)'
      using errcode = '42501';
  end if;

  if (new.is_correct, new.needs_review, new.graded_by)
     is not distinct from (old.is_correct, old.needs_review, old.graded_by) then
    return new; -- nothing changed
  end if;

  if new.graded_by is not distinct from 'auto' then
    if old.graded_by is distinct from 'auto' then
      raise exception 'Only the device can save a voice grade' using errcode = '42501';
    end if;
    new.graded_by := 'teacher'; -- the teacher changed a voice grade's result
  end if;

  select s.status <> 'finished' into v_active from sessions s where s.id = old.session_id;
  if coalesce(v_active, false) then
    if old.graded_by = 'auto' then
      raise exception 'Voice grades are locked until the session ends' using errcode = '42501';
    end if;
    return new; -- teacher / missed / skipped rows: editable, not a re-grade
  end if;

  -- session ended (or gone): a re-grade. The first one is remembered.
  if old.regraded_at is null then
    new.original_is_correct := old.is_correct;
    new.original_graded_by  := old.graded_by;
    new.regraded_by         := v_uid;
    new.regraded_at         := now();
  end if;
  return new;
end;
$$;

revoke execute on function public.word_attempts_grading_lock() from public, anon, authenticated;

drop trigger if exists word_attempts_grading_lock on public.word_attempts;
create trigger word_attempts_grading_lock
  before insert or update on public.word_attempts
  for each row execute function public.word_attempts_grading_lock();

-- ── Check after running ──────────────────────────────────────────────────────
-- select trigger_name, action_timing, event_manipulation from information_schema.triggers
-- where event_object_table = 'word_attempts' order by 1, 3;
--   → trg_log_teacher_grade AFTER INSERT / UPDATE,
--     word_attempts_grading_lock BEFORE INSERT / UPDATE
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop trigger if exists word_attempts_grading_lock on public.word_attempts;
-- drop function if exists public.word_attempts_grading_lock();
